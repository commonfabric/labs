# TypeScript Transformers Current Behavior Specification

**Status:** Descriptive (current behavior; on conflict, code/tests win — §21)\
**Package:** `@commonfabric/ts-transformers`\
**Last verified against:** origin/main `47ad2b898` plus this documentation branch,
2026-07-16 verification\
**Scope:** Compile-time behavior implemented in `packages/ts-transformers/src`
and exercised by current tests/fixtures. **Related:**

- `docs/specs/ts-transformer/ts_transformers_target_pattern_language_spec.md`
- `docs/specs/ts-transformer/ts_transformers_lowering_contract.md`
- `docs/specs/ts-transformer/ts_transformers_goals.md`
- `docs/specs/ts-transformer/cfc_authoring_contract.md` (implemented direct
  authoring, policy validation, and schema lowering — see §6.8)
- `docs/specs/ts-transformer/cfc_ui_helper_contract.md` (implemented contract;
  the helper rewrite and schema-hint behavior are described in §7.1 and §12)

## 1. Scope And Source Of Truth

This document specifies what the transformer system currently does, not what it
is intended to do in future design docs.

Authoritative implementation sources:

- `packages/ts-transformers/src/**`
- `packages/ts-transformers/test/**`
- fixture corpus under `packages/ts-transformers/test/fixtures/**`

If this document conflicts with code or passing tests, code/tests win.

## 2. Activation And Entry Conditions

### 2.1 Default-on pre-transform

Before AST transforms, `transformCfDirective()`:

1. Locates the first non-empty source line.
2. Prepends `import { __cfHelpers } from "commonfabric";` ahead of it (a named
   import of the internal helper binding, not a namespace import), and appends
   after the source a forwarding `h(...)` helper delegating to
   `__cfHelpers.h` — so authors need not import the JSX factory manually, and
   the helper module is not tree-shaken before binding. When the module
   scope already declares a value binding named `h` (a top-level function,
   class, enum, or namespace declaration, a top-level variable declaration
   including destructuring, any import binding — type-only imports
   included, since they still occupy the name — or a `var` hoisted out of a
   nested block or loop), the shim would be a duplicate identifier, so the
   same forwarding function is appended under the reserved name
   `__cfHelpersShim` instead. It stays a direct function declaration because
   that is the shape the runner's module-body verifier admits at module
   scope; a bare expression statement such as `void __cfHelpers;` is
   rejected there as top-level executable code
   (`packages/runner/test/engine-compile-evaluate.test.ts`). An import
   binding named `h` counts whatever its `type` modifier: whether it
   conflicts (TS2440) depends on the imported target's meaning, which the
   string-level scan cannot resolve. `interface h` / `type h` declarations,
   block-scoped `h` bindings in nested statements, and `h` bindings inside
   function or class bodies keep the `h` shim (`declaresTopLevelBinding`,
   `src/core/cf-helpers.ts`; pinned by `test/core/cf-helpers-coverage.test.ts`
   and the `ast-transform/top-level-h-binding` fixture). The scan and the
   guard below parse with the script kind the file name implies, so a `.ts`
   module's angle-bracket assertions do not read as JSX. Either trailer is
   two lines. §16.5 depends on that split: exactly one line is prepended.
3. Rejects sources that contain identifier `__cfHelpers` (or the reserved
   fallback shim name `__cfHelpersShim`) anywhere in the AST.

These string-level steps run in `transformCfDirective()`
(`src/core/cf-helpers.ts`) before any AST transformer, because symbol binding
happens before the transformer pipeline runs.

TypeScript's subsequent JSX emit uses `__cfHelpers.h` for elements and
`__cfHelpers.h.fragment` for fragment tags
(`packages/js-compiler/typescript/options.ts`). Both resolve through the
reserved helper binding, so authored locals and parameters named `h` retain
their ordinary meaning inside JSX-producing scopes, and a top-level `h` does
too (the renamed shim above). The forwarding `h()` function remains
available for explicit calls when the module does not bind `h` itself, and
either trailer keeps the helper import live during binding.

Legacy stored-envelope compatibility is deliberately separate from
`transformCfDirective()` (#4574, CT-1838):

- `isLegacyInjectedEnvelope(source)` is a public package export that recognizes
  the exact helper-injected form persisted by pre-#4158 pipelines. The first
  line must be byte-exactly `HELPERS_STMT`, the document must end with
  `"\n" + HELPERS_USED_STMT` or its JavaScript form, and the prefix/trailer may
  not overlap. A stripped final newline is accepted. Interior contents are not
  otherwise inspected (`src/core/cf-helpers.ts`;
  `test/core/legacy-envelope.test.ts`).
- The detector does **not** weaken the authored-source guard above. The runner
  consults it before `transformCfDirective()` only when
  `tolerateStoredLegacyEnvelope: true` is set on storage-fetched,
  Merkle-verified cold-load/fabric-mount input; an exact match passes through
  unchanged because it already contains the injected helper envelope. Normal
  authoring paths never set that option, so authored `__cfHelpers` input still
  throws (`packages/runner/src/harness/pretransform.ts`).

### 2.2 Pipeline object and cross-stage state

`CommonFabricTransformerPipeline` (`src/cf-pipeline.ts`) constructs one ordered
pipeline from `CFC_TRANSFORMER_STAGES`. Every stage shares:

- a single `diagnosticsCollector: TransformationDiagnostic[]`
- a single `CrossStageState` instance (`src/core/cross-stage-state.ts`), which
  is the sole owner of cross-transformer communication. It replaced the
  formerly-separate registry fields on `TransformationOptions`.

A stage reaches that instance as `context.state`. `TransformationContext`
resolves it once in its constructor — taking the caller's `options.state` when
one is supplied and creating a fresh instance otherwise — and stores the result
back into its own `options`, so a nested context built from those options joins
the same run. Every registry a stage reads through `context.state` is therefore
present; no stage handles a missing one.

`CrossStageState` organizes its registries into three deliberate families
(mirroring the TypeScript compiler's `NodeLinks` pattern):

1. **Bare cross-package maps** — the published boundary contract, read directly
   as plain `WeakMap`s by the separate schema-generator package, which must not
   depend on `CrossStageState`:
   - `typeRegistry: WeakMap<ts.Node, ts.Type>`
   - `schemaHints: WeakMap<ts.Node, SchemaHint>`
2. **`nodeLinks` side table** — a `WeakMap<ts.Node, NodeTypeLinks>` for
   transformer-internal, non-cache-invalidating per-node channels, reached only
   through record/lookup/mark/is accessors:
   - `capabilitySummary` (formerly the separate `capabilitySummaryRegistry`)
   - `schemaInjected` — a presence flag marking builder call/`new` nodes that
     SchemaInjection has finalized, replacing the scattered arg-count
     idempotency guards. It uses a plain presence check with **no**
     `getOriginalNode` fallback (it tags synthetic nodes whose original is the
     pre-injection user call).
   - `patternResultAnchor` — for a `toSchema` call SchemaInjection created to
     describe a pattern's **result**, the authored node a diagnostic about that
     schema points at. It is what tells SchemaGeneration which of a file's
     `toSchema` calls is a result rather than an argument, a handler's event or
     a nested claim; §6.12 is the rule that reads it. Like `schemaInjected` it
     is a plain identity lookup with **no** `getOriginalNode` fallback: the
     marker sits on the synthetic call SchemaInjection built, and that node
     reaches SchemaGeneration as the same object.
3. **Marker family** — node/symbol-keyed `WeakSet`s whose membership checks fall
   back through `getOriginalNode`, and whose mutators are coupled to the
   context's reactive-analysis cache invalidation (invalidation is a
   `TransformationContext` concern; `CrossStageState` stays a pure data holder):
   - `mapCallbackRegistry` (transformed array-method callbacks)
   - `syntheticComputeCallbackRegistry`
   - `syntheticComputeOwnedNodeRegistry`
   - `syntheticReactiveCollectionRegistry` (keyed by `ts.Symbol`)
4. **Diagnostic dedup channel** — `markDiagnosticReported(key)`
   (`cross-stage-state.ts:207`) backs `reportDiagnosticOnce`, so stages that
   may revisit the same node report a given diagnostic key once per run.

## 3. Pipeline Order (Normative)

The authoritative ordering lives in `CFC_TRANSFORMER_STAGES` /
`CFC_TRANSFORMER_STAGE_NAMES` in `src/cf-pipeline.ts`. Transformers always run
in this order (26 stages):

1. `CastValidationTransformer`
2. `EmptyArrayOfValidationTransformer`
3. `OpaqueGetValidationTransformer`
4. `PatternContextValidationTransformer`
5. `MergeablePushValidationTransformer`
6. `VerbReturnValidationTransformer`
7. `IndirectBuilderCallbackValidationTransformer`
8. `CfcPolicyAuthoringTransformer`
9. `CfcPolicyOfValidationTransformer`
10. `JsxExpressionSiteRouterTransformer`
11. `AssertDiagnosticsTransformer`
12. `LiftLoweringTransformer`
13. `ClosureTransformer`
14. `PatternOwnedExpressionSiteLoweringTransformer`
15. `HelperOwnedExpressionSiteLoweringTransformer`
16. `WriteAuthorizedByValidationTransformer`
17. `PatternCallbackLoweringTransformer`
18. `SchemaInjectionTransformer`
19. `BuilderCallHoistingTransformer`
20. `SchemaGeneratorTransformer`
21. `VerbTierMarkTransformer`
22. `ReactiveVariableForTransformer`
23. `ModuleScopeShadowingTransformer`
24. `ModuleScopeCfDataTransformer`
25. `PatternCoverageTransformer`
26. `ModuleScopeFunctionHardeningTransformer`
The order is behaviorally significant (invariant C-002). Two ordering facts
worth calling out:

- `BuilderCallHoistingTransformer` (stage 19) runs **after**
  `SchemaInjectionTransformer` (stage 18) so each builder call it relocates to
  module scope already carries its injected schemas — see CT-1644 and
  `packages/ts-transformers/docs/derive-to-lift-design.md`. This stage hoists
  `lift`, `handler`, and `pattern` builder calls. It absorbed and replaced the
  former separate `LiftHoistingTransformer` (which hoisted only `lift`); the
  even-older `BuilderCallbackHoistingTransformer` was deleted (#3864). Earlier
  spec revisions listing those two as distinct stages are obsolete.
- The final five stages (22–26) run last so they operate on fully lowered and
  schema-injected output; they are documented stage by stage in §13–§17.
- `MergeablePushValidationTransformer` (stage 5; #4450/#4505) is
  validation-only and is documented with the other validators (§6.9).
- `PatternCoverageTransformer` (stage 25) does no work unless pattern runtime
  coverage is enabled. When enabled, it runs before
  `ModuleScopeFunctionHardeningTransformer` so coverage counters are added to
  authored bodies before hardening helpers are emitted (§16).

## 4. Global Options

`TransformationOptions` carries no mode switch. Every transformer behaves the
same way on every compile: the pipeline rewrites, and reports a diagnostic only
where a rule is actually violated. There is no validate-only configuration that
reports what a rewrite would have been.

The options that do change what a compile produces are described alongside the
behavior they change:

- `patternCoverage` — coverage instrumentation (§16)
- `moduleIdentities` and `canonicalWriterIdentityFile` — the file spellings and
  module identities that writer-identity claims are minted with (§17.3)
- `assertDiagnostics` — whether an `assert(...)` body records its operands, so
  that a failing pattern-test assertion can report them
- `state` and `diagnosticsCollector` — cross-stage communication and diagnostic
  collection (§2)

## 5. Call Kind Detection Contract

`detectCallKind()` drives multiple transformers. The set of recognized Common
Fabric runtime exports — and, for each, its call category and whether it is a
**reactive origin** — is defined in one place:
`COMMONFABRIC_RUNTIME_EXPORT_REGISTRY`
(`src/core/commonfabric-runtime-registry.ts`). A guard test
(`test/core/commonfabric-runtime-registry.test.ts`) asserts the registry covers
every callable the runner's builder factory injects, so the registry — not this
list — is the authoritative source. As of this writing it recognizes:

- builders (all reactive-origin): `pattern`, `handler`, `action`, `lift`,
  `computed`, `render`. (`byRef` and `uiVariant` are registered-but-`ignored`
  exports — recognized so the registry guard test stays exhaustive, treated as
  plain calls.)
- conditional-helper calls: `ifElse`, `when`, `unless`
- reactive array calls (`map`, `mapWithPattern`, `filter`, `filterWithPattern`,
  `flatMap`, `flatMapWithPattern`, `count`, `countWithPattern`, `minBy`,
  `minByWithPattern`, `maxBy`, `maxByWithPattern`)
- cell factories (`cell`, `new Cell`, `new OpaqueCell`, `new Stream`, etc.),
  with legacy `.of(...)` still accepted
- `Cell.for`-style calls
- `wish`
- `generateObject` and `generateText`
- the `runtime-call` family — tagged-call / function runtime origins: `str`,
  `llm`, `llmDialog`, the fetch family from the #4206 split — `fetchJson`
  (which additionally gets dedicated type-argument schema injection, §10.5),
  `fetchJsonUnchecked`, `fetchText`, `fetchBinary` — `fetchProgram`,
  `streamData`, `cellFromUrl`,
  `compileAndRun`, `navigateTo`, and the SQLite builtins `sqliteDatabase` /
  `sqliteQuery` (`sqliteQuery<Row>` additionally gets dedicated type-argument
  schema injection)
- `patternTool` — recognized, but explicitly **not** a reactive origin
  (`reactiveOrigin: false`)

Detection is provenance-first:

1. symbol resolution against Common Fabric declarations/imports
2. stable alias/signature following (`const alias = computed`,
   `declare const alias: typeof ifElse`)
3. synthetic helper support for `__cfHelpers.*` nodes introduced by earlier
   passes

Remaining fallback behavior is intentionally narrow:

- unresolved bare builder identifiers can still match builders
- ambient builder declarations and ambient call-signature aliases can still
  classify as builders in type-only environments
- shadowed local helpers and object methods with Common Fabric-like names are not
  classified
- a **synthetic** property call spelled `mapWithPattern` /
  `filterWithPattern` / `flatMapWithPattern` / `countWithPattern` /
  `minByWithPattern` / `maxByWithPattern` whose method resolves to **no
  symbol** classifies as the array-method family by spelling alone. The
  closure stage emits these calls against receivers whose static type is
  still the plain array type (a site-lifted collection local, for example),
  so the method never resolves and the emitted spelling is the only
  remaining evidence of the family — this is what keeps post-closure stages
  from wrapping an already-rewritten call in a second lift. The
  synthetic-node requirement scopes that testimony to calls the transformer
  actually produced: an **authored** `*WithPattern` spelling keeps its
  author's semantics whether its method resolves (their own declaration) or
  not (an untyped receiver classifies as no call kind). Authored spellings
  of every family that fail symbol resolution still require a reactive
  receiver to classify

The `*WithPattern` argument-hoisting path also requires a synthetic callee.
Only closure-stage output guarantees that callback captures have been threaded
through the params argument; an authored inline pattern stays in its enclosing
scope.

Builder-placement validation uses `detectDirectBuilderCall()`, so calls to
functions returned by builders are not reclassified as direct `lift()` or
`handler()` invocations.

## 6. Validation Transformers

### 6.1 Cast validation

Validates `as` and angle-bracket assertions:

- **Error** `cast-validation:double-unknown`
  - `expr as unknown as X`
  - `<X><unknown>expr`
  - parenthesized/mixed equivalents
- **Error** `cast-validation:forbidden-cast`
  - casts to `Reactive<...>`
- **Error** `cast-validation:cell-cast`
  - casts to cell-like types: `Cell`, `OpaqueCell`, `Stream`, `ComparableCell`,
    `ReadonlyCell`, `WriteonlyCell`, `Writable`, `CellTypeConstructor`

### 6.2 Empty Array Cell-Factory Validation

On cell-factory calls with an empty array literal and no explicit type argument:

- `new Cell([])`, `new Writable([])`, `new OpaqueCell([])`, `new Stream([])`,
  deprecated `cell([])`, and other recognized cell factories
- **Error** `cell-factory:empty-array`
  - explains that `[]` infers to `never[]` and suggests
    `new Cell<MyType[]>([])`-style explicit type arguments.

No error when:

- explicit type arguments are provided
- array literal is non-empty
- first argument is not an array literal
- `.of()` has no first argument

### 6.3 Opaque `.get()` validation

On call `receiver.get()` (no args):

- if receiver cell kind resolves to `"cell"` or `"stream"`:
  - no diagnostic (these types legitimately have `.get()`)
- otherwise if receiver either:
  - resolves to opaque cell kind (`"opaque"`) via `getCellKind()`, or
  - is structurally reactive — `isReactiveExpression` walks the receiver and
    treats it as reactive when it is (or its property/element-access root is):
    - a **`pattern` / `render` callback parameter** (including via destructured
      binding elements), or
    - a local variable whose initializer is a **reactive-origin call** (after
      stripping the transparent wrapper set — parentheses, `as`, `<T>`,
      `satisfies`, `!` — and property/element-access tails), as defined by
      `isReactiveOriginCall` / the runtime registry (§5):
      reactive-origin builders (`pattern`, `computed`, `lift`, `handler`,
      `action`, `render`), the lift-applied shape, `ifElse` / `when` / `unless`,
      cell factories / `Cell.for`, `wish`, `generateObject`, `generateText`, and
      the `runtime-call` family (`str`, `llm`, …)
  - **Error** `opaque-get:invalid-call`
  - message instructs direct access, clarifies only `Writable<T>`/`Cell<T>`
    reads require `.get()`.

Deliberate non-coverage of the structural fallback: `lift` / `handler` /
`action` callback **parameters** are not inferred as opaque from structure
alone — they keep their declared cell semantics. The structural inference exists
only for the `Reactive<T> = T` identity-alias case where the cell brand is
gone.

Same-named local helpers are not treated as reactive origins unless the call
itself resolves through the Common Fabric provenance rules in §5.

### 6.3a The event parameter serves the authored contract

A verb's event parameter (handler/action first parameter) with an AUTHORED
type — an explicit parameter annotation, or the builder call's own event
type argument, which the action strategy now carries into the lowered
`handler` call — is applied in `contract` mode
(`CapabilitySummaryApplicationMode` in `type-shrinking.ts`). The authored
TypeNode serves VERBATIM in structure — objects, unions, intersections,
arrays, and primitives alike, `$defs` identities and prose intact — and
`overlayContractCapabilities` (`type-shrinking.ts`) rewrites only
capability-bearing positions: a cell-like wrapper takes the capability the
body's usage earns (writable where it writes, read-only where it reads,
comparable where it only compares, OPAQUE where it never touches the
position), and an identity-only comparison of a plain-declared position adds
the comparable marker the runtime materializes it through. A named reference
whose subtree holds no cell-like position passes through untouched; one
expands only when a capability inside it must change, and a self-referential
type ends that expansion at the cycle with the node kept as authored — the
accepted residual, since a literal cannot spell its own recursion. Observed
paths still validate against the authored type via `validateShrinkCoverage`.

A SYNTHETIC event node — JSX handler events among them — has no authored
structure to serve and keeps the `full` usage shrink, as does a handler with
no event type information at all: for those, the usage summary is the only
contract there is. Reactive reads (`lift`, lift-applied, computed) stay in
`full` mode always: there, shrinking is subscription semantics. The ruling
this implements is
[the verb input contract](../../history/plans/verb-input-contract.md); the
`handler-schema/contract-authored-event`,
`contract-nested-unread-reference`, and `contract-authored-shapes` fixtures
pin the shapes.

The type-driven shrink preserves cell wrappers and resolves normalized value
paths against their inner types. A stored field named `count`, `map`, or `get`
therefore retains its value type and cell capability when captured by `computed`
or `assert`, even when the wrapper has a method with the same name. Inline
object values in optional cell handles and optional stored values retain their
requested fields and read-only capability while preserving nullish alternatives.
A `.get()` whose result is not resolved to a specific member path retains the
receiver's complete stored shape, including when the result passes through a
helper. Optional member reads retain the receiver without imposing a full-shape
read.

A cell reached through a type alias — `type ProfileCell = Writable<...>` —
gives the transformer no authored node for its value, so the value type is
printed inside the inferred capability wrapper. Schema generation can read
some prints only from the type behind them: `import("./mod.ts").T` for a name
the emitting module does not import, and the brand arm of an expanded
`Default`. A skipped computed brand marks the node-driven schema as incomplete
even when the remaining union and intersection members can be read, so the
resolved value supplies the default metadata.
Where the cell is a property, schema generation reads the value from the
property's resolved type; where the cell is the whole argument there is no
such type, so the printed node is registered in `typeRegistry` with the value
type it was printed from. An aliased cell therefore emits the value schema the
same wrapper emits written inline, under every inferred capability, for a
generic alias, and for an alias imported from another module. One shape
differs: `T | Default<V>` where `V` is an object type assignable to `T`.
Inline, the authored `Default` node shows that `T` already covers `V`, and the
schema is `T` with the default. Through an alias the resolved union keeps `V`
as a member of its own, and the schema is `anyOf: [T, V]` with the default.
`aliased-cell-value-schema.test.ts` pins these.

The type-driven shrink also guards its descent on (type, requested-paths): a
pair already on the path falls back to the named type reference — no
structural fallback — which schema generation resolves through `$defs`
exactly as it does for an authored node.

### 6.4 Schema shrink validation

Validates that property paths detected by capability analysis can actually
resolve against the declared parameter type during schema shrinking.

Detection occurs in `applyShrinkAndWrap` and `validateShrinkCoverage` (both in
`type-shrinking.ts`; `schema-injection.ts` and `lift-applied-strategy.ts` call
into them), including the `defaults_only` branch of
`applyCapabilitySummaryToArgument`. After shrinking completes,
`validateShrinkCoverage` compares requested top-level path heads against what
was materialized in the shrunk result.

Path extraction (`extractAccessPath` in capability-analysis.ts) sees through the
non-semantic wrappers `unwrapExpression` strips — parenthesization, `as`
assertions, angle-bracket type assertions, `satisfies`, and non-null (`!`) — at
every level of property/element access chains. `unwrapExpression` is applied to
the receiver after each property/element step, so for example `(state as any)
.foo` resolves to a read of `state.foo`. This means single casts (or
`satisfies`/`!` wrappers) do not hide property accesses from capability
analysis.

When interprocedural analysis is enabled (compute-context builders like `lift`,
`handler`), read paths discovered in helper function bodies propagate
back to the caller's parameter summary, but the current MVP intentionally only
does this for resolved helper bodies in the same source file. Cross-file or
otherwise unsupported helper calls fall back to the conservative wildcard path
instead of taking partial transitive precision. This means a `lift` callback
that delegates to a local helper which reads `(x as any).foo` will trigger
shrink validation on the caller's parameter type, while the same helper body in
another file will conservatively disable shrinking for that parameter.

When a wildcard parameter (one passed to an opaque/unanalyzable function like
`console.log`) is typed `unknown`, validation emits `schema:unknown-type-access`
because the generated schema cannot express what data to fetch. This does not
apply to `any`-typed parameters (which fetch everything at runtime) or to
concrete types (which already describe the expected shape).

Declared members typed as `unknown` also trigger `schema:unknown-type-access`
when accessed, even if the property name exists in the declared interface/type
literal. This catches cases like `{ data?: unknown }` where the schema would
otherwise degrade to `{ type: "unknown" }` for that property and the runtime
could not express the required fetch shape.

Guards that skip validation:

- wildcard parameters with a non-`unknown` base type (full-shape access,
  shrinking is disabled)
- parameters with no read/write paths and no wildcard flag
- synthetic parameters injected by the pipeline (`__cf_pattern_input`,
  `__param0`, etc. — names starting with `__`)
- `never`-typed parameters (bottom type, vacuously valid)
- `any`-typed parameters (top type; the runtime fetches everything, so every key
  is reachable — this is what distinguishes `any` from `unknown`)
- paths whose head is `"key"` (reactive proxy accessor injected by
  `PatternCallbackLoweringTransformer`)

Diagnostics:

- **Error** `schema:unknown-type-access`
  - fires in any of these cases:
    - parameter base type is `unknown` and the code accesses properties
    - parameter base type is an **uninstantiated generic type parameter** and
      the code accesses properties (the `isUnknownBase` check treats
      `TypeFlags.TypeParameter` like `Unknown` — an unresolved `<T>` base cannot
      express a fetch shape any more than `unknown` can)
    - one or more accessed property heads resolve to `unknown`-typed **members**
      on an otherwise concrete type (e.g. `{ data?: unknown }`)
    - a **wildcard** parameter (passed to an opaque/unanalyzable function) whose
      base type is `unknown` (see the wildcard note above)
  - message lists the accessed property heads and instructs the author to
    replace `unknown` with a concrete type
- **Error** `schema:path-not-in-type`
  - parameter has a concrete type but one or more accessed properties are not
    present in that type
  - message lists missing properties and the declared type text, instructs the
    author to add them

When `shrunk` is `undefined` (as in `defaults_only` mode where full shrinking is
skipped), validation falls back to inspecting the base type node directly.

Union and array type support: validation uses `typeHasProperty()` which checks
whether a specific property head resolves against the type through three layers:
the shrunk TypeNode, the base TypeNode, and the resolved `ts.Type`. For union
types (e.g. `{ amount?: number } | undefined`), non-nullish constituents are
checked individually — a head is valid if ANY non-nullish member has it. For
array types (e.g. `number[]`), numeric heads like `"0"` are valid when the type
has a numeric index signature. TypeReferences within unions are resolved to
their declaration members. This eliminates false `schema:path-not-in-type`
errors on nullable/optional union patterns and array index accesses.

### 6.5 Pattern-context validation

Enforces restricted reactive context rules.

Restricted contexts are callbacks of:

- `pattern`
- `render`
- transformed array-method callbacks (`.map(...)`, `.filter(...)`,
  `.flatMap(...)` and their `...WithPattern(...)` forms)

Compute wrappers override restrictions:

- `computed`, `action`, `lift`, `handler` callbacks
- inline JSX `on*` handlers
- standalone function definitions
- JSX expressions (handled by reactive JSX transformer)
- the SQLite `table(columns, (row) => ({...}))` row-label rule callback —
  classified as the supported `sqlite-row-label-rule` compute boundary
  (`callback-boundary.ts`). `table()` is recognized by name **plus** the
  `SqliteTableFunction` type alias from Common Fabric's own typings (so an
  unrelated user function named `table` does not match). The rule callback is
  evaluated eagerly at pattern build into a serialized JSON AST, so it is
  compute-owned and is deliberately exempt from SES self-containment validation
  (see the `ses-callback:callable-capture` exclusion below).

Diagnostics emitted in all modes:

- **Error** `pattern-context:get-call`
  - a `.get()` read in restricted reactive context with no lowerable
    expression site to carry it: a statement-position read (`count.get();`),
    a read inside a reactive array-method callback
    (`rows.map((row) => row.cell.get())`, whose callback becomes a sub-pattern
    over per-element cells rather than pattern-body code), or a read whose
    receiver is not a `Cell`/`Writable`/`Stream` (`items.get()` on a plain
    pattern input, which also draws `opaque-get:invalid-call`)
  - a read inside a plain (non-reactive) array `map` callback
    (`["-", "+"].map((sep) => rows.get().join(sep))`) is accepted. That
    callback runs eagerly during pattern build and `map` collects what it
    returns without reading it, so its value sites are pattern-owned wrapper
    sites like the pattern body's own, and each iteration's site lowers to its
    own lift-applied computation. The result-interpreting array callbacks
    (`filter`, `find`, `some`, `every`, `sort`, `flatMap`, `reduce`) keep the
    diagnostic
  - a cell read that DOES sit at a lowerable site is not rejected: the site is
    auto-wrapped into a lift-applied computation. That covers the read itself
    (`const v = count.get()`, `{ value: count.get() }`,
    `input.key("count").get()` at a return site), a computation over it
    (`{ value: count.get() * 2 }`), and a call whose receiver chain reaches it
    (`rows.get().join(",")`, `rows.get().filter(...)`, which lowers through
    `filterWithPattern`). Parentheses around the site and the computed-key
    spelling of the read (`layout["get"]()`) do not change the decision, and
    neither does optionality — `layout?.get()` and `layout?.get?.()` on a cell
    lower like their non-optional spellings, per the 2026-07-23
    optionality-orthogonality resolution. The bare/parenthesized spelling
    pairs across site kinds are pinned by the `test/validation.test.ts`
    "Paren-Invariance Twins" battery. Each lift's input schema shrinks to
    what its body reads (`test/validation.test.ts:3179`; goldens
    `cell-get-binding-autowrap`, `cell-get-terminal-binding-autowrap`,
    `with-reactive`). This is the ratified has-a-lowerable-site rule —
    target-language spec §5.7 and its matrix rows are normative for it
- **Error** `pattern-context:function-creation`
  - function creation in pattern context unless inside compute
    wrappers/JSX/allowed callbacks
  - the allowed-callback determination reads the callback's call-argument
    position through parentheses, so `toSorted(((a, b) => ...))` classifies
    like `toSorted((a, b) => ...)` — target-language spec §5.7
    paren-invariance (`test/validation.test.ts` "allows a parenthesized
    inline callback argument"); parentheses grant nothing outside argument
    position ("still errors on a parenthesized arrow function in pattern
    body")
  - class expression or declaration in pattern context unless inside compute
    wrappers; the whole class is flagged once with a class-specific message
- **Error** `pattern-context:object-member`
  - a function-valued member of an object literal in pattern or render
    context: a method, getter, setter, or a property whose value is an
    arrow/function expression (including inside JSX data positions, and when
    the function is wrapped in transparent expressions — parentheses, `as`,
    `satisfies`, `!`, `<T>`)
  - rejected regardless of the body, and with no exception by member name,
    because the reactive-read lowering pass does not descend into function
    bodies
  - the message names the mechanism per kind: a getter runs once when the
    result is stored and freezes its return to a snapshot; a method, setter, or
    function-valued property is a function value the reactive data model cannot
    store (it throws ``Not representable as a `FabricValue`: function``)
  - exempt: members inside compute wrappers (computed/lift/handler/action),
    object literals outside pattern/render context, JSX event handlers, and
    array-method/render callbacks; class members are covered separately by
    `pattern-context:function-creation`
- **Error** `pattern-context:builder-placement`
  - direct `lift()` or `handler()` inside restricted context
  - special message for immediate `lift(fn)(args)` suggesting `computed()`
- **Error** `standalone-function:reactive-operation`
  - in standalone functions (except inline first arg to `patternTool`):
    `computed(...)`, `lift(...)`, or reactive collection methods on reactive
    receivers
  - what counts as a standalone definition is read through transparent
    parentheses: `const helper = (() => ...)` is validated (and context-
    classified) like its bare spelling
  - collection-method diagnostics currently use `.map(...)`-style guidance and
    suggest eager `<cell>.get().map(...)` when explicit eager mapping is
    acceptable
- **Error** `compute-context:local-reactive-use`
  - inside a `computed(...)`/`lift(...)` callback, a reactive value created in
    that same callback is consumed as a plain value in control-flow or another
    non-lowered computation site
  - typical culprits are local `computed(...)`, `lift(...)`,
    `wish(...)`, or reactive collection aliases and their property accesses
  - message instructs the author to move the use into a nested
    `computed(() => ...)` or module-scope `lift()`
- **Error** `pattern-context:optional-chaining`
  - optional property / element access that appears outside a supported
    lowerable expression site — including inside a lowered array-method
    callback (`map`/`filter`/`flatMap`) and inside a callback whose owning
    call has no lowerable site
  - a plain array `map` callback supplies such a site for the reactive values
    it closes over, so `weekDates?.[colIdx] === todayDate` bound inside
    `COLUMN_INDICES.map((colIdx) => …)` lowers rather than erroring; an
    optional access on the callback's own plain parameter
    (`["a", "bb"].map((s) => s?.length ?? 0)`) has nothing reactive to lift
    and still errors, and so does one in a callback whose result the method
    reads (`rows.get().filter((r) => r?.flag)`)
  - an optional access inside an inline callback argument is carried by the
    callback's owning call when that call is outside the lowered array-method
    families and itself sits at a lowerable expression site: the site's lift
    absorbs the callback, so the access runs on resolved values
    (`rows.get().toSorted((a, b) => (a?.sentAt ?? 0) - (b?.sentAt ?? 0))`);
    parentheses around the inline callback change neither the carrier nor
    the callback allowance (`test/validation.test.ts` "allows optional
    access inside a parenthesized inline comparator" pins the spelling at
    zero diagnostics)
  - optional calls do not receive this diagnostic merely because they are
    optional: their underlying call root is classified by the same policy as a
    non-optional call
  - at supported expression sites, receiver optionality (`value?.method()`),
    invocation optionality (`value.method?.()`), and combined chains lower as
    whole calls with JavaScript short-circuit and receiver semantics intact
  - message instructs the author to wrap the computation in
    `computed(() => ...)` or move it to a site that lowers
- **Error** `pattern-context:computation`
  - binary/unary/conditional computations using opaque dependencies outside
    wrappers
  - also the catch-all for other non-lowerable reactive reads at a top-level
    pattern site — notably **bare dynamic key (element) access** like
    `scopes[key]` directly in a pattern-body value position (the target-language
    spec's "bare dynamic key access in top-level pattern-facing code" =
    Unsupported). The same access is fine inside JSX, a computation callback, a
    collection callback, or a structural binding form.
  - validation first checks the shared lowerable-expression-site policy; only
    non-lowerable computation sites still report this error (so `items[0].name`,
    `name.toUpperCase()` at lowerable top-level sites, and dynamic keys inside
    supported contexts validate clean)
- **Error** `pattern-context:callback-container`
  - a callback passed to an **unsupported container** in pattern-facing JSX
    (the callback-boundary decision is `unsupported` with
    `boundaryDiagnostic === "callback-container"`) — e.g. a foreign imperative
    container root like `[0, 1].forEach(() => list.map(...))`. This is the
    diagnostic counterpart of the target-language spec's "foreign callback /
    imperative container roots" unsupported bucket. Guidance: use a supported
    array-method/value call, an event handler, or move the work into
    `computed(() => ...)`, module-scope `lift()`, or a helper.
- **Error** `pattern-context:patterntool-requires-pattern`
  - `patternTool(fn, ...)` where the first argument is a bare callback (arrow /
    function expression, read through transparent parentheses) rather than a
    `pattern(...)`. The runtime/transformer
    auto-wrapping (`pattern(fn)`) and auto-capture were removed in CT-1655;
    authors now wrap explicitly: `patternTool(pattern(fn), extraParams?)`. The
    diagnostic is reported on the bare-callback argument.
- **Error** `ses-callback:callable-capture`
  - a callback at an SES-self-contained boundary captures a **callable**
    declared in an enclosing function scope. The boundary kinds that require
    self-containment are `SES_SELF_CONTAINED_CALLBACK_BOUNDARIES`:
    `event-handler`, `reactive-array-method`, `pattern-tool`, `pattern-builder`,
    `render-builder`, `lift-applied`, `computed-builder`, `action-builder`,
    `lift-builder`, `handler-builder`. (`sqlite-row-label-rule` is deliberately
    excluded — `table()` evaluates its rule callback eagerly at pattern build
    into a serialized AST, so capture is harmless there.) SES callback
    implementations must be self-contained. Guidance: move callable helpers to
    module scope, or pass serializable data through explicit inputs/state.
    Capturing non-callable reactive data is still allowed.
- **Error** `pattern-context:assignment` / `pattern-context:early-return` /
  `pattern-context:let-declaration` / `pattern-context:loop` /
  `pattern-context:var-declaration`
  - statement-boundary imperative structure in top-level pattern-owned code —
    assignments, early returns, `let`/`var` declarations, and loops each
    report a dedicated id (`pattern-context-validation.ts:539-633`). These
    enforce the target-language matrix's "statement-boundary imperative
    constructs" Unsupported row and have been live since the boundary PR
    (#3154).

Removed diagnostic (behavior change, PR #3154 pattern-language-boundary): the
former `pattern-context:map-on-fallback` error no longer exists.
Fallback-guarded reactive collection forms such as `(items ?? []).map(...)`,
`(items || []).filter(...)`, and `(items ?? []).flatMap(...)` — including
cast-/`satisfies`-wrapped reactive left sides — are now **supported** and emit no
fallback-specific diagnostic. `test/validation.test.ts` retains these as
regression guards asserting the forms validate clean.

### 6.6 Pattern Result Schema Inference

When `pattern()` is called with zero or one type parameters and the result
schema must be inferred, CTS requires the inferred top-level result shape to be
structurally representable.

- structurally recoverable object-literal returns still emit concrete object
  schemas even when some individual property values come from `any`-typed
  expressions
- direct top-level `any` / `unknown` result inference emits
  `pattern:any-result-schema`
- individual inferred-result **fields** whose type is `unknown` emit **Error**
  `pattern-result:unknown-type`, naming the offending paths — the schema would
  carry `{ type: "unknown" }` there, which a consumer does not materialize: it
  reads the field back as an opaque reference carrying no properties
  (`schema-injection.ts:2621`)
- authors who intentionally want a permissive/opaque output boundary must make
  it explicit with `pattern<Input, Output>(...)`

This inference runs through `collectFunctionSchemaTypeNodes` via
`inferReturnType`, object-literal recovery, and direct projection recovery.

### 6.7 Lowerable Expression-Site Categories

The shared expression-site policy recognizes seven authored container kinds via
`getExpressionContainerKind` (the `ExpressionContainerKind` union in
`expression-site-types.ts`):

- `jsx-expression`
- `template-span` (an interpolated `${…}` span inside a tagged template, e.g.
  a `str`-tagged template)
- `return-expression`
- `variable-initializer`
- `call-argument`
- `object-property`
- `array-element`

Those container kinds are the raw building blocks for the author-facing buckets
described in the target-language spec:

- JSX expressions
- top-level pattern-body value-expression sites
- callback-local value-expression sites inside supported collection callbacks,
  both the reactive ones that become sub-patterns and the plain-array `map`
  callbacks that run during pattern build

`isEligiblePatternOwnedWrapperCallbackSite` decides the third bucket from the
enclosing callback's boundary kind
(`supportsPatternOwnedWrapperCallbackSite`, `policy/callback-boundary.ts`).
`reactive-array-method`, `pattern-builder`, and `render-builder` carry
pattern-owned sites outright; the compute-owned boundaries (`computed`,
`action`, `lift`, `handler`, event handlers) never do.

`plain-array-value` carries them only for the callback role that can hold
them, which `isCollectingPlainArrayMethodCallback` (`ast/call-kind.ts`)
decides. It admits a callback that is argument zero of the configured
default-library `Array`/`ReadonlyArray` type and names a method in
`COLLECTING_ARRAY_METHOD_NAMES` — today `map` alone — over a plain receiver no
reactive lowering owns. A source or ambient type merely named `Array` or
`ReadonlyArray` is not a standard array. `map` stores each result without
reading it, so a result that is a cell stays a cell. Every other callback-taking
array method reads the result as it runs:
`filter`, `find`, `some`, and `every` as a boolean, `sort` as a number,
`flatMap` as an array test, `reduce` as the next accumulator. A cell reaching
any of those is an object, which is truthy, not a number, and not an array, so
those callbacks keep the diagnostic instead.

`findLowerableExpressionSite` walks outward through enclosing pattern-context
containers until it finds the nearest lowerable site admitted by
`classifyExpressionSiteHandling`.

`findPreferredNestedLowerableExpressionSite` is narrower: it only picks nested
structural sites with container kinds `call-argument`, `object-property`, or
`array-element`.

These categories do not mean "rewrite every descendant expression." Explicit
computation callbacks still create their own ownership boundary, and every site
must separately satisfy the shared handling policy.

In particular, explicit compute callbacks remain an ownership boundary for
recursive lowering. That boundary does not disappear just because the callback
returns JSX: ternaries and logical control flow inside the compute callback
body stay authored JavaScript rather than recursively lowered helper control
flow.

### 6.8 CFC authoring and validation

The pipeline implements both schema aliases and direct module-authored exchange
rules. `CfcPolicyAuthoringTransformer` validates and lowers static exported
`exchangeRule(...)` / `exchangeRules([...])` declarations, stamps deterministic
rule names, and records compiler manifests in cross-stage state. The manifests
are side-channel compiler artifacts and never JavaScript module exports.

`CfcPolicyOfValidationTransformer` accepts only a direct
`PolicyOf<typeof rules>` query of an exported ruleset. Schema generation binds
that reference to the defining module identity, export symbol, exact manifest
digest, and an owning-space placeholder. Direct imports and pinned `cf:` imports
retain the dependency's identity.

Both recognizers read a declaration's initializer through the transparent wrapper set (parentheses, `as`, `<T>x`, `satisfies`, `!`, and partially emitted nodes), so an
authored rule or ruleset is recognized however it is spelled. A spelling not
stripped does not surface as a wrapper problem: the authoring pass reports the
rule as invalid, and the `PolicyOf` pass reports that the binding must resolve
to an `exchangeRules()` declaration — each naming the declaration rather than
the wrapper that hid it.

`WriteAuthorizedByValidationTransformer` separately validates writer-binding
claims.

It scans `toSchema<T>()` (one type arg) and `pattern<I, R>()` (the result type
arg) for `WriteAuthorizedBy<T, typeof binding>` references, resolving through
local type aliases and type-parameter substitution
(`findWriteAuthorizedByReferences`). For each reference it emits
**`cfc-write-authorized-by`** when usage is malformed:

- the second type argument is not a `typeof` binding (`TypeQueryNode`)
- the `typeof` target is not a simple identifier
- the bound name is not a supported origin — a local `handler()` / `module()` /
  `requireEventIntegrity()` initializer, or a local function declaration

Well-formed `WriteAuthorizedBy` usage passes validation; the base schema
lowers as `T` plus the writer-identity claim (`ifc.writeAuthorizedBy` carrying
the `__ctWriterIdentityOf` binding marker, preserved through schema emission —
see the identity tests in `test/cfc-authoring.test.ts`). This stage is
exercised by `test/cfc-authoring.test.ts`,
`test/cfc-transformer-coverage.test.ts`, and pipeline regressions.

`ts-transformers` also re-exports the canonical CFC alias-name set
(`CFC_CANONICAL_ALIAS_NAMES`, from `@commonfabric/api/cfc`) via
`src/cfc-authoring.ts` — `Cfc`, `Confidential`, `Integrity`,
`AnyOf`, `PolicyOf`, `WriteAuthorizedBy`, the `TrustedAction*` family, the
projection aliases, etc.
(The former collection/opaque helpers — `OpaqueInput`, `SubsetOf`,
`FilteredFrom`, `LengthPreservedFrom`, `PermutationOf` — were removed: the
runner rejects their lowered `ifc` keys fail-closed.) The canonical aliases
are lowered into schema `ifc` metadata by the schema-generator's
common-fabric formatter during the `SchemaGeneratorTransformer` stage (the
lowering rules live in `cfc_authoring_contract.md`); `WriteAuthorizedBy`
additionally gets the transformer-side validation above.

### 6.9 Mergeable-push validation

`MergeablePushValidationTransformer` (stage 5; #4450, classification refined
in #4505) analyzes handler callbacks for reads of a mergeable collection
followed by a push to the same collection, and reports:

- **Warning** `mergeable-push:read-then-push`
  (`src/transformers/mergeable-push-validation.ts:116`)
  - findings are deduplicated per collection root+path per handler; when a
    collection classifies under more than one misuse kind, the
    read-dependent-push diagnosis wins over independent-read-modify-write as
    the stronger, more actionable one (the dedup comment states this)
  - the message text is produced per classification by `diagnosticMessage`;
    capability analysis feeds the findings via `mergeablePushMisuseSink`

### 6.9a Nested collection scan validation

`PatternContextValidationTransformer` reports **Warning**
`collection:nested-scan` (`src/diagnostics/nested-collection-scan.ts`) for an
inline reactive array-method callback scanning a captured reactive collection.
It recognizes the array-method families classified by `classifyArrayMethodCallSite`
and checks the receiver's array type and reactive provenance. Callback parameters
and callback-local declarations as collection roots are excluded, so a row's
own child array or a locally derived
child list does not trigger this warning. The reported receiver must resolve to
a captured root binding; complex receiver expressions are outside this check.
Indexed receiver results, plain local arrays, sequential scans, lowered calls, and scans
inside unrelated function boundaries are excluded. The warning does not change
execution or claim that every update scans both collections; it asks the author
to measure potentially multiplicative work and consider contract-compatible
shared work, indexed lookups, or named aggregates.

### 6.10 Verb-return validation

`VerbReturnValidationTransformer` (stage 6; verb contract WS-C/C2) inspects
authored `action(...)` and `handler(...)` calls whose result type argument is
absent or explicitly `void` (`action`'s 2nd slot, `handler`'s 3rd), and
reports:

- **Error** `verb-result:undeclared-return`
  (`src/transformers/verb-return-validation.ts`) — a block body contains a
  top-level `return <expr>` whose expression is **definitely plain-shaped**:
  an object/array literal, a string/number/boolean/null literal, a template
  string, or arithmetic/concatenation over such operands (recursing through the
  transparent wrapper set — parentheses, `as`, `<T>x`, `satisfies`, `!`, and
  partially emitted nodes — and through conditionals). An assertion whose type
  is `any` opts the expression out whichever assertion form carries it, because
  the validator then cannot judge the shape. The message points
  the author at declaring the result (`action<Event, Result>` /
  `handler<Event, State, Result>`) or using a bare `return;` for an early
  exit.

Everything else is deliberately exempt, and each exemption is a recorded
decision rather than a gap:

- **Concise (expression) bodies** — absorbing their completion value is the
  no-inference decision: `action((id) => selected.set(id))` returns the cell
  and nobody wrote a verb result.
- **Bare `return;` and `return undefined;`** — control flow.
- **Calls, identifiers, property reads, JSX** — the launch/navigation/render
  idioms (`return navigateTo(piece)`, returning a freshly created piece,
  returning rendered UI), which the runtime consumes without a declaration.
  Types cannot discriminate these: the authored surface renders `Reactive<T>`
  transparently, so `navigateTo(...)` types as plain `boolean` — syntax is
  the only honest signal.
- **Returns inside nested function-likes** — they return to their own
  callers.

### 6.11 Indirect builder callback validation

`IndirectBuilderCallbackValidationTransformer` (stage 7) reports a callback a
trusted builder reaches through a reference the module verifier cannot follow:

- **Error** `builder-callback:indirect-reference`
  (`src/transformers/indirect-builder-callback-validation.ts`) — the argument
  the verifier treats as the callback is function-bearing, but resolves to
  neither a function written at the call nor a name bound to a function this
  module emits. A property access (`handler(event, state, callbacks.save)`)
  and an imported binding are the two shapes that reach it most often. The
  message names how the callback was reached and points the author at binding
  the function in this module or writing it at the call.

Resolution follows a name through this module's own declarations, so a chain
of aliases ending at a local function resolves exactly as the verifier's
binding walk resolves it. Two shapes that read as functions are not ones the
verifier admits, and are reported: a **generator**, which is not
direct-callback syntax to `tryParseDirectFunction` (it accepts `async`, never
`function*`), and a declaration with **no body** — ambient, or an overload
signature — which is erased before emit, leaving the compiled module with a
name bound to nothing. An overloaded function resolves through its
implementation.

An **exported variable** declaration is reported for the same reason §17.3
annotates exported bindings inline: CommonJS emit reads its references as
`exports.<name>`, which the verifier's grammar does not admit as a callback
target. Only the `export` modifier on the declaration does this — a function
declaration keeps its local binding even when exported, and a trailing
`export { … }` clause rewrites no reference, so both stay accepted.

Which argument is judged mirrors `callbackIndexesForBuilder`, including its
window rather than only its answer: `lift`'s callback belongs at position 0,
but the verifier scans the leading positions and takes the first that
resolves, so all three are judged here too. A candidate that resolves ends the
check, because that is the one the verifier would take.

The rule belongs to `verifyTrustedBuilderCall`
(`runner/src/sandbox/compiled-bundle-verifier.ts`, normative per §17.6), which
admits those two spellings and refuses to load a module using any other. This
stage exists so the refusal arrives from the compile that produced the module,
against the offending argument, rather than at load from a message phrased in
terms the pattern source never mentions. Its per-builder callback positions
mirror that verifier's, so a trusted-builder result passed in a data position
is never judged as a miswritten callback.

An argument that is not function-bearing is left alone: that is a different
mistake, and whatever already rejects it describes it more accurately than a
callback diagnostic would.

### 6.12 Diagnostics emitted by lowering stages

Not every diagnostic comes from a validation transformer. The lowering stages
report these through the same collector (deduplicated via §2.2's
`markDiagnosticReported` channel):

- **Warning** `schema-default:unresolved` (`schema-generator.ts`) — the
  schema generator cannot recover a `Default<>` or `DeepDefault<>` value after
  trying the node, type, and applicable brand-payload routes. That annotation
  supplies no schema default; compilation continues. The warning points to the
  default value type when it belongs to the current file, otherwise to the local
  schema use.
  Repeated reports for that source range collapse to one. See §7 of the
  schema-generator mapping spec and `test/default-empty-record-schema.test.ts`.
- **Error** `pattern-context:receiver-method-call`
  (`pattern-body-reactive-root-lowering.ts:162`) — the pattern-body
  reactive-root seam could not admit a receiver-method call on a tracked
  reactive root at that site
- **Error** `pattern-context:inline-reactive-root-access`
  (`pattern-body-reactive-root-lowering.ts:1467`) — an inline tracked
  reactive-root read at a position that stage cannot lower
- **Error** `pattern-result:unknown-type` (`schema-injection.ts:2621`) — see
  §6.6
- **Error** `pattern-result:opaque-reserved-key`
  (`reserved-result-keys.ts`, called from `schema-generator.ts`) — a pattern's
  own result declares one of the framework's reserved keys `unknown` at its
  root; demoted to a **Warning** under `TransformationOptions.storedSource`
  (an identity-pinned reload of durable stored source admits nothing new, so
  the report keeps its visibility and loses its veto); see §6.12
- **Error** `reactive-capture:unknown-type` (`src/ast/type-building.ts:681`) —
  a captured reactive value's inferred type is `unknown`, so its schema would
  be `{ type: "unknown" }` and the runner would not materialize it, reading it
  back as an opaque reference carrying no properties; the message directs
  authors to add an explicit type
- **Error** `reactive:call-argument-computation`
  (`expression-rewrite/emitters/compute-wrap-invariants.ts:112`) — an authored
  reactive computation (e.g. `profile ?? profileWish.result` or
  `users.length === 0`) written inline inside the argument subtree of an owned
  pattern boundary call (a builder / bound-handler invocation, a lift-applied
  call, or an array-method call), where the compute-wrap guard
  (`resolveComputeWrapCandidate`) refuses the emitters' wrap because that
  boundary owns lowering for its own arguments. The message advises hoisting
  the computation to a body-level const or `computed(...)` and passing that
  value instead. This disagreement previously crashed the whole compile as an
  internal invariant error (found via lunch-poll's
  `joinAs({ ..., profile: profile ?? profileWish.result })` during the #4928
  rework); the internal throw remains only for compiler-synthesized culprits
  (a true pipeline bug) and for the culprit-already-compute disagreement
  shape.

### 6.12 Reserved keys at the root of a pattern's own result

A reserved key's spelling belongs to the framework rather than to whoever
described it: a pattern result carries `$UI` and `$NAME` whatever the author's
type says. At the root of a result, then, the value under such a key is one
this pattern produced — the screen it built, the name it chose. `unknown` is
the declaration for a field holding a reference to another piece, and it
projects to an empty object carrying only a back-to-cell annotation, so a
result that declares a reserved key `unknown` loses that value for every reader
of it. Rendering is unaffected: a piece's screen is read under a schema the
renderer supplies, and the pattern's declared result schema never enters that
path. That is what makes the defect invisible until something reads the screen
as a value.

`reportOpaqueReservedResultKeys` (`src/transformers/reserved-result-keys.ts`)
reports it as **Error** `pattern-result:opaque-reserved-key`, naming every
offending key in one diagnostic. Under `TransformationOptions.storedSource` —
the runner engine's cold-recovery recompile of durable stored source, where an
identity pin guarantees the compile reconstructs an already-admitted artifact
rather than admitting a new one — the same diagnostic reports as a
**Warning**: a rule added after those bytes were admitted must not brick
their reload, while authoring paths stay strict because the author is present
to fix the shape. It runs from SchemaGeneration, which is the
one place a declared result exists as the schema it generated — whatever type
the author named, and whichever inference path §10.2 took to reach it.
SchemaInjection records the result schema calls and the node to point at
(§2.2's `patternResultAnchor`).

The rule reaches the root of a result schema and nothing else. Two shapes stay
legal, and a rule written without them breaks working patterns:

- **The argument side.** An argument schema is checked contravariantly by
  `deno task pattern-compat` — it has to keep accepting every value it
  accepted before — so a consumer that takes stored pieces of any vintage
  cannot narrow it. `BackwardsCompatibleProfile` in
  `packages/patterns/system/profile-home.tsx` is such a seam.
- **Below the root.** A reserved key one level down names a field of another
  piece, where `unknown` is what keeps the field a reference to that piece's own
  screen rather than a copy, so the controls in it stay bound to the piece that
  owns them.

Root-ness follows a `$ref` into `$defs`, because a `$ref` measures the same
value against another schema — a recursive result type emits exactly that
shape. It follows nothing else: a `$ref` the generator cannot resolve locally,
or a root that is a combinator rather than an object, is left alone.

The list of reserved keys is `FRAMEWORK_RESULT_KEYS`
(`packages/utils/src/framework-result-keys.ts`). The runner builds pattern
results and reads those keys back off them, this package decides what a
pattern may declare about them, and neither may import the other, so the
spelling sits in a package below both and the runner's builder surface
re-exports it.

A `pattern()` call that already carries both schemas as arguments is left as
SchemaInjection finds it (§10.2), so no result schema is recorded for it and
the rule does not reach a hand-written schema literal.

## 7. JSX Expression Site Routing And Early Rewriting

`JsxExpressionSiteRouterTransformer` runs only when helper import is present.

### 7.1 Top-level behavior

Before expression-site routing, the visitor first rewrites recognized CFC UI
helper elements (`UiAction` / `UiPromptSlot` / `UiDisclosure`) via
`rewriteUiHelperElement` (`src/transformers/ui-helper-lowering.ts`): the
helper tag is replaced by its `as` prop or the helper's default intrinsic tag,
helper-only props are re-emitted as `data-ui-*` attributes, non-helper props
and children are preserved, and — when the required semantic props are string
literals — a `cfcUiContract` schema hint is recorded for later
`ifc.uiContract` emission (§6.8, §12).

Event-handler attribute detection (`isEventHandlerJsxAttribute`,
`src/ast/event-handlers.ts`) treats an attribute as a handler site when its
name has the `on` prefix OR its contextual type is handler-like (every call
signature takes at most one parameter).

For each `JsxExpression`:

- skip empty JSX expressions and event-handler attributes
- run data-flow analysis (`createDataFlowAnalyzer`)
- if no rewrite required and no logical binary operators (`&&`, `||`), skip
- in compute context:
  - only semantic logical rewrites (`&&`/`||`) are considered
  - computed wrapping is skipped
- compute-context JSX does not lower `&&` / `||`
- pattern-context JSX lowers `&&` / `||` deterministically

### 7.2 Emitter behaviors

The rewriter uses normalized data-flow dependencies and ordered emitters:

1. property access
2. binary expression
3. call expression
4. template expression
5. conditional expression
6. element access
7. prefix unary
8. container expression

The container emitter owns a literal that holds other expressions, and a
transparent wrapper around one: it rewrites the children and leaves the
container unwrapped. It reads the transparent wrapper set (parentheses, `as`,
`<T>x`, `satisfies`, `!`, and partially emitted nodes), so a wrapped container
is owned on the same terms as a bare one.

The data-flow analysis behind these emitters reads that same set twice. An
expression wrapped in it is analyzed as the expression it wraps, which is what
carries the inner analysis's `rewriteHint` out to the caller — a spelling not
named there falls to the generic child walk, which merges through
`mergeAnalyses` and drops the hint. Normalization then groups flows by their
normalized text, and strips the set before comparing, so flows differing only
by a wrapper collapse into one dependency instead of splitting.

Capture selection reads it a third time. A lift captures the fields its body
reads, and the dedup deciding that asks each data flow for its root identifier,
looking through member access, calls, and the wrapper set. A reference whose
root goes unrecognized is not merely skipped: the free-identifier pass then adds
that root as a capture of its own, and a whole-object capture subsumes the
narrower paths beside it. The lift is then applied to the whole object and
re-runs for any field of it, where it could have been applied to the one field
the body reads.

Callback-local declarations are excluded from captures using parameter lineage
and the owning function's authored range. Rebuilt callbacks carry that range in
their source maps. Matching requires the same function kind and exact range;
ancestor traversal stops at intervening function boundaries, keeping nested
parameters out of an enclosing callback's capture object.

The set has one deliberately narrow reader on the way out. When the rewriter
synthesizes an `ifElse`/`when`/`unless` call, `unwrapParentheses` tidies the
operands placed in the call, and the probe recognizing a zero-arg inline IIFE
callee reads through the same function: parentheses alone come off. Every
other transparent wrapper can carry a type, and schema injection still reads
operand types at those argument positions, so `as`, `<T>x`, `satisfies`, and
`!` stay on the operands — a ternary branch reading `state.note!` keeps a
non-nullable operand schema because the assertion stays in the tree.

Key rewrite rules:

- `a && b`: lowers to `when(condition, value)` only in pattern context
- `a || b`: lowers to `unless(condition, fallback)` only in pattern context
- ternary `cond ? x : y`:
  - becomes `ifElse(cond, x, y)` with branch/predicate processing
  - when rewriting a collection receiver establishes callback ownership, the
    callback is registered before its body is visited, so discriminator
    comparisons are evaluated reactively
  - whole-branch wrappers exclude bindings declared inside nested callbacks
    while retaining outer captures, including outer bindings with the same name
- array-method family calls are never wrapped as a unit: the analysis marks
  them `skip-call-rewrite`, so only the receiver chain before the method is
  processed. Via §5's spelling fallback this equally covers an
  already-rewritten symbol-less `*WithPattern` call encountered inside a
  processed branch — it stays in place rather than acquiring a lift around
  the rewritten call
- non-compute contexts:
  - complex reactive expressions are wrapped via `computed(() => expr)` (later
    lowered to the lift-applied form)
- compute contexts:
  - no computed wrappers; only child rewrites and logical conversions

Collection index selectors (`groupBy` / `keyBy` on explicit array-valued cells)
use the array callback pipeline and its `WithPattern` form. Each selector return
is evaluated inside a computation that tags whether its result is a Cell before
serialization. Primitive fields are read as values; Cell fields retain their
identity without reading their contents. A nullish selected value omits that
source occurrence. The pattern-owned expression pass skips synthetic computation
callbacks, preserving ordinary JavaScript conditionals inside the key tagger.
The computation carries the tagged selector output type into its lift schema.
Bare terminal returns and fallthrough emit `void 0`, preserving omitted keys
when a selector binds a local variable named `undefined`. The schema injected
for the handle an operator returns names that operator's missing-key mode —
`group` for `groupBy`, `key` for `keyBy` — because `GroupIndex` and `KeyIndex`
pin the `mode` field of `CollectionIndexData` (`packages/api/index.ts`); the
runtime reads the mode from there for an index whose descriptor has not been
published.

Helper-owned compute branches introduced by ternary / conditional-helper
rewriting are re-analyzed with synthetic compute ownership. This preserves
plain-array semantics inside fully compute-wrapped branches while still letting
later stages recover reactive collection rewrites for locally rewrapped aliases
created inside compute code.

Before adding a compute wrapper, the binary / ternary-branch / helper-owned
emitters (and the late pattern-body initializer wrap) consult the compute-wrap
guard `resolveComputeWrapCandidate`
(`expression-rewrite/emitters/compute-wrap-invariants.ts`). A disagreement with
the shared reactive-context classification either returns a `skip-reported`
verdict after reporting the author-facing `reactive:call-argument-computation`
diagnostic (authored culprit inside an owned pattern boundary — see §6.10) or
throws the internal compiler-bug invariant (synthetic culprit, or a culprit the
classifier already considers compute).

Synthetic calls generated by this pass register result types in `typeRegistry`
for later schema injection.

## 8. Lift-Applied Lowering

`LiftLoweringTransformer` rewrites Common Fabric `computed(...)` calls into the
canonical lift-applied form:

- `computed(fn)` -> `__cfHelpers.lift(fn)({})` before schema injection
- no-input computed-origin calls are schema-injected as
  `__cfHelpers.lift(fn, false, undefined, { completeSchedulerScopeSummary: true })()`
  after closure analysis has proven that the empty input contains no captures
  (function first; `false` preserves computed's no-argument runtime semantics,
  and `undefined` keeps the options object in lift's fourth parameter)
- **does not** forward `computed`'s type argument to `lift`: `computed<R>` has a
  single result type param, while `lift<T, R>` takes input `T` first, so
  forwarding `[R]` would place `R` in `lift`'s input slot. Type args are
  recomputed downstream (the lift-applied closure transform / SchemaInjection) from the
  callback's parameter and return types.
- does not additionally validate callback shape in this pass
- preserves type information through `typeRegistry` (the original call's type is
  re-registered on the lowered lift-applied node)

It runs only when source text contains `computed` or AST scan finds computed
calls.

## 9. Closure Transformation

`ClosureTransformer` runs only when helper import is present. It applies the
first matching strategy (the strategies array in `closures/transformer.ts`), in
order:

1. handler JSX attribute strategy
2. action strategy
3. array-method strategy
4. lift-applied strategy

Strategy rebuilds — and the callbacks `PatternBuilder` assembles for them —
carry the replaced nodes' source-map ranges (§11.5).

There is no longer a separate patternTool closure strategy (CT-1655, #3862):
`patternTool` now requires an explicit `pattern(...)` first argument (see
§6.5 `pattern-context:patterntool-requires-pattern`), so the captures live on
that authored pattern and the call is hoisted by `BuilderCallHoisting` (§11)
rather than capture-rewritten here.

### 9.1 Capture model

Capture analysis:

- captures identifiers/property chains declared outside callback scope
- excludes imports, module-scoped declarations, function declarations, type
  parameters, JSX tag names, property keys
- captures nested callback closures with filtering for outer locals/params
- builds hierarchical capture trees by root path

Input-bound expression wrappers also capture enclosing function locals used
inside nested callbacks. Parameters and locals declared within the wrapped
expression stay inside it, including when the wrapper belongs to a reactive
collection callback. Module bindings remain lexical references.

A capture's type is inferred from its expression, with literal types widened.
One case reads the declaration instead. Inside a pattern body, a binding
destructured from the callback parameter has its `Default` and scope wrappers
(`PerSpace`, `PerUser`, `PerSession`, `PerAny`) stripped from its type. A
binding whose declared property type carries one — as the type itself, as a
member of a union or an intersection, or as the argument of a cell wrapper that
keeps it — is therefore emitted from the type node its author wrote
(`getPreservedTypeForBindingElement`, `src/ast/type-building.ts`). The cell
wrappers that keep their argument are `Cell`, `Writable`, `ReadonlyCell`,
`WriteonlyCell`, `ComparableCell`, and `Stream`, classified by spelling in
`ARGUMENT_KEEPING_WRAPPER_NAMES`: a binding declared with one is captured as
that cell, and capability narrowing wraps the argument it reads from the
authored node, so a `Cell` of a value captures with the same `default` and
`scope` as a `Writable` of that value. The argument read is the first, the value
the cell holds; a `Stream`'s declared result is not read. A `computed()`
captures an `OpaqueCell` as its value, and `Reactive<T>` is `T` itself, so the
authored node of either would be captured as a cell; a binding declared with one
is typed by inference, and its capture carries no default. A wrapper's name
counts only where it resolves to the declaration `commonfabric` exports: a type
of the author's own named `Default` is an ordinary type, and its binding is
typed by inference. At any of those positions, a reference to a non-generic type
alias whose type carries a wrapper is replaced by the type the alias names, so
`type Draft = Writable<string | Default<"">>` captures with the schema of the
wrapper written in place, including when the alias is imported from another
module. A reference to an alias that carries no wrapper stays a reference, which
schema generation emits under the alias's name. A reference to a generic alias
also stays as written, and when nothing else in the declared type carries a
wrapper the capture is typed by inference.

A property of a generic input is declared in terms of the input's type
parameters. The pattern builder's type argument supplies the caller's arguments,
before callback normalization strips defaults and scopes; inherited properties
and nested or renamed destructuring follow that type. A parameter that sits in a
union, an intersection, parentheses, or a wrapper is replaced by a node printed
from its argument, which gives the schema of the concrete type written in place.
That holds where the printed argument reads the same wherever it is emitted:
keywords, literals, type literals, and a name without type arguments that names
the argument's own type where the binding is declared. The printer writes a bare
name without asking what it resolves to there, so the name is checked against
the symbols the argument's type mentions. Every other generic binding — a
parameter inside another type expression such as `Box<T>`, `T[K]`, or `T[]`, or
an argument that prints as a reference with type arguments, as `import("…").T`,
as `typeof x`, or as a name that is out of scope there or names another type —
is emitted as its instantiated declared type. That keeps the wrapper and the
complete value type, and keeps a default's value as a member of the union:
`anyOf: [T, V]` with the default, where the concrete type written in place emits
`T` with the default. The pattern body's view of such a binding is not used,
because stripping `Default<{}>` from `T | {}` lets the union reduce to `{}`.
When the builder's type argument cannot be found, as when
`pattern<Input<number>>` is bound to a name before it is called, the only
instantiated type on hand is the pattern body's view, and the binding is emitted
with its concrete value type and without its default.

A union of two instantiations of one generic input gives a type parameter two
arguments. No node stands for both, so such a parameter is not substituted and
the binding takes its instantiated declared type, which holds every branch.

Pattern result inference reads returned input bindings through the same
function when a returned binding carries a scope wrapper. Scope detection reads
both the emitted node and the recovered declaration: the printer can emit
`unknown` for a scoped generic array, while its declaration still names the
scope the result must retain. A node printed from a type is registered with that
type rather than with the type at the expression, which is the pattern body's
view: the names a printed node spells
resolve to nothing where it is emitted, so schema generation reads it by the
type behind it. An authored node keeps the view's type, and so keeps being
emitted in place rather than under the name of whatever alias the declared
type carries.

`aliased-binding-declared-type.test.ts` and
`ast/getPreservedBindingTypeNode.test.ts` pin these.

### 9.2 Handler strategy

Transforms inline JSX event handlers:

- `<el onClick={() => ...} />` ->
  `onClick={handler<Event,State>((event, params) => ...)(captures)}`
- currently unwraps arrow functions only (not function expressions), and
  reaches the arrow through the transparent wrapper set (parentheses, `as`, `<T>x`, `satisfies`, `!`, and partially emitted nodes)
- boundary classification looks for the JSX attribute from the outermost
  wrapper around the callback rather than from the callback itself, so
  extraction and classification agree on where the callback sits. When they
  disagree the cost is a false positive on legal source — a wrapped handler
  draws `pattern-context:*` diagnostics its bare spelling does not
- preserves body after recursive child transforms

### 9.3 Action strategy

Transforms `action(...)` to handler factory invocation:

- `action(cb)` -> `handler<EventSchema,StateSchema>(rewrittenCb)(capturesObj)`
- event schema:
  - no event param -> `never`
  - event param present -> inferred/explicit type
- `action<Event, Result>(cb)` adds `Result` as a third type argument on the
  emitted `handler`, which is where the declared result would otherwise be
  lost: the rewritten call carries schemas rather than the authored type
  arguments. SchemaInjection lowers that slot (§10.3).
- callback extraction supports arrow callbacks only, and reaches the arrow
  through the transparent wrapper set (parentheses, `as`, `<T>x`, `satisfies`, `!`, and partially emitted nodes). The whole set comes off: a spelling left on hides the callback
  from this strategy, and `action(...)` then survives into the emitted module,
  where the runtime throws because `action` exists only to be lowered here

### 9.4 Array-method strategy

Transforms eligible reactive collection operators to explicit `...WithPattern`
forms with explicit capture params.

Transform eligibility:

- decision is context/receiver-policy driven:
  - pattern context + reactive receiver origin -> transform
  - pattern context + receiver identifier bound, directly in a `pattern` /
    `render` builder callback body, to an initializer the shared
    expression-site policy classifies as a lowerable `variable-initializer`
    site (`const view = rows.get().filter(...)`, which §6.5's autowrap turns
    into a lift) -> transform, and the receiver symbol is registered in
    `syntheticReactiveCollectionRegistry` so post-closure consumers of the
    provenance walk agree with the decision. A local inside a JSX IIFE or any
    other callback is not admitted here — it belongs to that callback's own
    lowering
  - compute context + `celllike_requires_rewrite` receiver kind -> transform
  - compute context + `opaque_autounwrapped` receiver kind -> do not transform
  - compute context + local alias in the same callback whose initializer
    re-wraps a reactive collection (`computed`, `lift`, `action`, `handler`,
    `wish`, already-rewritten collection calls, or other reactive cell-like
    receivers) -> transform
- plain array `.map()` is not transformed
- an inline cell-read receiver (`rows.get().filter(...)` used directly as a
  `.map` receiver, or standing alone) is NOT transformed by this strategy —
  the read itself is the thing being lowered, and the expression-site
  machinery owns it (§6.5); inside standalone hardened functions the eager
  `<cell>.get().filter(...)` spelling stays untouched plain JavaScript
- the inline callback argument is read through transparent parentheses:
  `receiver.map(((r) => ...))` lowers exactly like the bare spelling
  (target-language spec §5.7 paren-invariance; fixture
  `map-paren-wrapped-callback` pins the emission)
- transformed callbacks are marked in `mapCallbackRegistry` and become
  pattern-callback contexts for downstream classification
- a collection chain consumed by a terminal operation such as `slice` or
  `join` runs its callbacks as plain JavaScript inside the chain's lift. This
  computation boundary takes precedence over an enclosing reactive collection
  callback; nested array calls do not inherit that outer pattern context
- synthetic compute-owned array-method nodes assert that stale pattern ownership
  is not retained after earlier rewrites

Result shape:

- `receiver.<method>(fn[, thisArg])` ->
  `receiver.<method>WithPattern(pattern(callbackSchema, resultSchema, newCallback), paramsObj[, thisArg])`
- supported callback methods are `map`, `filter`, `flatMap`, `count`, `minBy`,
  and `maxBy`; the aggregate forms require explicit cell receivers in the
  public type surface
- argument-free `count`, `sum`, `min`, and `max` remain direct builtin-building
  method calls
- callback schema includes `{ element, index?, array? }` and adds `params` only
  when captures exist
- computed destructuring keys are stabilized with generated key constants and
  lift-applied wrappers where needed

### 9.5 Lift-applied strategy

Transforms lift-applied closures only when captures exist.

Supported input forms:

- `lift(callback)(input)`
- `lift(callback, argumentSchema, resultSchema[, options])(input)`

Behavior:

- merge original input and captures into one input object
- rewrite callback parameters to explicit destructuring
- resolve name collisions (`name`, `name_1`, ...)
- preserve/reinfer callback result type
- skip explicit type args when result type is uninstantiated type parameter
- register lift-applied call type for downstream inference
- re-analyze the rewritten callback's merged input and, when needed, append one
  scheduler-options object to the inner `lift` call:
  - `materializerWriteInputPaths` is emitted when the first parameter's
    capability summary has one or more write paths. Each path is an array of
    static string segments. The write metadata remains present even when the
    overall scope is not provably complete.
  - `completeSchedulerScopeSummary: true` is emitted only when the function is
    non-recursive, has no unreadable cell arguments, and every parameter has no
    wildcard, unverified cell use, passthrough, opaque capability, or opaque
    paths. A proven-empty summary qualifies.
  - the object may contain either field or both, and is omitted when neither
    condition holds (`closures/strategies/lift-applied-strategy.ts`;
    `test/pipeline-regressions.test.ts`).
- during §10 schema injection, argument/result schemas are inserted after the
  callback and before those options, producing
  `lift(callback, argumentSchema, resultSchema, options?)(input)`. The
  zero-input/no-capture computed form is handled separately as described in §8.

The runtime meaning of `materializerWriteInputPaths` is specified in
`docs/specs/scheduler-v2/README.md` §4.3 (the write-surface tiers).

If no captures are found, the lift-applied call is left unchanged.

### 9.6 patternTool (no closure strategy)

There is no patternTool closure strategy in the current pipeline. The former
strategy auto-wrapped a bare callback as `pattern(fn)` and auto-captured
module-scoped reactive values into the call; both were removed in CT-1655
(#3862) in favor of an explicit, addressable pattern.

Current behavior:

- `patternTool(...)`'s first argument **must** be an explicit `pattern(...)`; a
  bare callback reports `pattern-context:patterntool-requires-pattern` (§6.5).
- the captures live on the authored `pattern(...)` (module-scoped reads are
  absorbed by the pattern; per-instance values go in `extraParams`).
- the bare `pattern(...)` inside `patternTool(...)` is hoisted to module scope
  by `BuilderCallHoisting` (§11, argument-position pattern case).

### 9.7 Pattern callback lowering

`PatternCallbackLoweringTransformer` runs after closure transformation.

Primary behaviors:

- rewrites pattern-style callback parameter destructuring to explicit input
  bindings with `input.key(...)`-based prologues
- lowers property/optional-navigation reads on opaque roots to `.key(...)`
  access in pattern contexts
- preserves terminal path methods (`get`, `set`, `update`, etc.) and rewrites
  only the receiver path portion when needed
- treats dynamic key access and spread as non-lowerable in unsupported pattern
  contexts with diagnostics
- classifies optional calls by their underlying call kind and expression site;
  optionality itself neither admits nor rejects a call
- treats wildcard traversals (`Object.keys/values/entries`, `JSON.stringify`) as
  broad/full-shape access for capability analysis, but allows whole-call
  lowering when they appear in supported expression-root positions
- classifies map captures as reactive vs non-reactive and avoids `.key(...)`
  rewrites for non-reactive captures
- recursively rewrites lift-applied callback bodies so locally-declared
  opaque/reactive aliases created inside compute callbacks (including inside
  nested blocks) also receive `.key(...)` lowering
- local opaque-root discovery is symbol-scoped and block-aware to avoid
  same-name false rewrites across scopes
- extracts static destructuring defaults into capability summaries for schema
  default application
- registers capability summaries for transformed callbacks/builders for
  downstream schema shrinking/wrapping

#### 9.7.1 Current non-JSX expression-site split

Current-main behavior distinguishes three buckets for non-JSX authored sites:

1. **top-level pattern-owned ordinary call roots**
   - when the authored site root is an ordinary call (for example
     `identity(state.done ? "Done" : "Pending")`), the shared expression-site
     path whole-wraps that call in a lift-applied computation
   - this applies across non-JSX container kinds such as
     `variable-initializer`, `object-property`, `array-element`, and
     `return-expression`
2. **explicit compute callbacks**
   - `computed` / `action` / `lift` / `handler` callbacks remain the
     explicit reactive boundary
   - inside those callbacks, authored conditionals stay authored JS inside the
     callback body rather than being rewritten to helper control flow
3. **supported collection-callback locals**
   - callback-local **ordinary call roots** now join the shared ordinary-call
     slice across `variable-initializer`, `object-property`, `array-element`,
     and direct `return-expression` sites, so the whole call lowers as a
     callback-local lift-applied computation
   - callback-local **plain structural control-flow sites** that are not under
     an owning ordinary call root still lower directly (for example bare
     conditional `object-property` / `array-element` / `variable-initializer`
     expressions lowering to `ifElse(...)`)

In other words, the split is now explicitly **call-root vs nested structural
site ownership** rather than a special-case callback return-expression rule.

## 10. Schema Injection

`SchemaInjectionTransformer` runs only when helper import is present. It injects
`toSchema<...>()` calls (later materialized to JSON schema literals). Every
builder call it rebuilds carries the replaced call's source-map range (§11.5).

### 10.1 General typing rules

- uses explicit type annotations when present
- otherwise infers from signatures/contextual types
- `_param` convention implies `never` schema for that parameter
- failed inference falls back to `unknown`
- `typeRegistry` is consulted first for synthetic nodes/types
- Common Fabric generic aliases retain their authored type arguments when
  qualified through `__cfHelpers`; argument pairing uses the alias arguments,
  which can differ from the arguments of its underlying reference type.

### 10.2 `pattern(...)`

Builder schema injection supports function-first signatures and preserves that
ordering in output.

Cases:

- 2+ type args: input and result from type args
- 1 type arg: input from type arg, result inferred
- no type args:
  - if 2 schema args already present: unchanged
  - if 1 schema arg present: treated as input schema, infer result schema
  - if none: infer both

When inferring the result schema (0 or 1 type args), CTS requires a
structurally representable top-level result:

- structurally recoverable object-literal returns still emit concrete object
  schemas when CTS can recover their shape (see §6.6)
- direct top-level `any` / `unknown` result inference emits
  `pattern:any-result-schema`
- permissive/opaque result semantics are still allowed when made explicit via a
  result type parameter

### 10.3 `handler(...)`

- with type args `<Event, State>`:
  - prepends event/state schemas
  - unresolved generic helper-definition-site type parameters degrade to
    `{ type: "unknown" }`
- the schema-first authored form `handler<Event, State[, Result]>(eventSchema,
  stateSchema, callback[, options])` — recognized when arguments 0 and 1 are
  not callable and argument 2 is, with callable-ness taken from the checker's
  call signatures rather than from the expression's spelling, so an arrow, a
  reference, a function declaration, and a property access all recognize the
  form — keeps its authored arguments: nothing is prepended, since generated
  schemas on top would displace the callback out of the positions the runtime
  dispatch and the sandbox verifier accept (argument 0 or 2). A declared
  `Result` still lowers onto the trailing options object exactly as below;
  without one the call passes through unchanged. Fixture:
  `handler-schema/schema-first-declared-result`.
- with single function arg:
  - infers event/state schemas from parameters
  - event absent -> `never`; untyped params -> `unknown`
- with a third type arg `<Event, State, Result>`: appends a trailing options
  object carrying `{ resultSchema: toSchema<Result>() }`. `action<Event,
  Result>` reaches the same emission — its lowering to `handler` carries the
  declared result into this third type-argument slot (§7). An absent third
  argument, and an explicit `void`, emit no options object at all: a declared
  result is opt-in and never inferred, so a concise body whose completion
  value happens to be a cell declares nothing. A call that already passes an
  options object keeps it, spread into the same object.
  The runtime reads `resultSchema` off that slot onto the node's
  `Module.resultSchema` (`packages/runner/src/builder/module.ts`); it does NOT
  reach the pattern's own `resultSchema`, which is what the piece update gate
  compares across versions.

### 10.4 `lift(...)`

If schemas are not already present via type args:

- infer input/result schema types from arguments and callbacks
- literal-based input inference widens literals (`"x"` -> `string`, `1` ->
  `number`, etc.)
- when inferred result type is missing or degrades to `any`/`unknown`, recovery
  first attempts object-literal return reconstruction and then direct projection
  recovery (`x => x.foo`, `x => x["foo"]`)
- direct projection recovery can reuse result types recovered from local
  `lift(...)` initializer aliases registered in `typeRegistry`
- unresolved generic helper-definition-site type parameters degrade to
  `{ type: "unknown" }` when schemas are injected from explicit builder type
  arguments

### 10.5 Cell factories and related APIs

Injected behaviors:

- `cell(...)`, `new Cell(...)`, `new OpaqueCell(...)`, `new Stream(...)`, etc.:
  - inject schema as second argument if missing
  - if no value arg, inject `undefined` then schema
  - value inference first uses registry/initializer recovery for transformed
    expressions before falling back to the direct value type
  - direct semantic `any` values emit `true`
  - direct semantic `unknown` values emit `{ type: "unknown" }`
  - if the value type at a generic helper definition site is an uninstantiated
    type parameter, CTS degrades the emitted schema to `{ type: "unknown" }`
    instead of leaking `{}` or omitting the schema
- `Cell.for(...)`-style calls:
  - wrap with `.asSchema(schema)` unless already wrapped
- `wish(...)`:
  - append schema as second argument if missing
  - explicit or contextual unresolved generic type parameters degrade to
    `{ type: "unknown" }`
- `generateObject(...)`:
  - ensure options object has `schema` property (merge/spread as needed)
  - explicit or contextual unresolved generic result types degrade to
    `{ type: "unknown" }`
- `sqliteQuery<Row>(...)`:
  - the **typed** form lowers the `Row` type argument to an injected `rowSchema`
    property on the options object (parallel to `generateObject`'s `schema`);
    the runtime builtin composes `result.items = rowSchema`. Two call shapes
    inject it: the free function `sqliteQuery<Row>({ db, sql, ... })` (options at
    arg 0) and a method form. Idempotent (skips when `rowSchema` already
    present).
  - untyped `sqliteQuery(...)` is not injected. Other SQLite builtins
    (`sqliteDatabase`, etc.) are recognized reactive-origin `runtime-call`s (§5)
    but receive no dedicated schema injection.
- `fetchJson<T>(...)` (#4206 fetch-family split):
  - the typed form lowers the `T` type argument to an injected `schema`
    property on the options object (parallel to `generateObject`)
  - an untyped `fetchJson(...)` call is a hard **Error**
    `fetch-json:missing-type-argument` (`schema-injection.ts:4015`), directing
    authors to add a type argument or use `fetchJsonUnchecked` for JSON whose
    shape is not declared as a type. `fetchText` / `fetchBinary` /
    `fetchJsonUnchecked` receive no dedicated injection.

### 10.6 Conditional helpers

Injects schemas for helper calls when absent:

- `when(condition, value)` -> prepend 3 schemas: condition/value/result
- `unless(condition, fallback)` -> prepend 3 schemas
- `ifElse(condition, ifTrue, ifFalse)` -> prepend 4 schemas

These use widened literal inference and register inferred types.

### 10.7 Capability summary application

When capability summaries are available, schema injection applies wrapper/path
adjustments:

- wrapper selection based on observed capability:
  - `readonly` -> `ReadonlyCell<T>`
  - `writeonly` -> `WriteonlyCell<T>`
  - `writable` -> `Writable<T>`
  - `comparable` -> `ComparableCell<T>`
  - `opaque` -> `OpaqueCell<T>`
- compute-oriented boundaries apply full path shrink + wrapper selection
- type aliases and interfaces (TypeReferenceNodes) are resolved to their
  declaration members and shrunk in-place, preserving source-level type
  annotations (Date formats, enum literals, `$ref`/`$defs`). When all members
  are retained the original TypeReference is kept for schema fidelity.
- pattern boundaries apply defaults-only mode to preserve broad shape continuity
  while still applying extracted static defaults
- wildcard roots disable path shrinking for affected parameters/arguments
- capability analysis resolves member access through `.get()` when the member
  access itself is observed (`notes.get().length` records `["length"]` rather
  than a blanket root read) and suppresses the redundant blanket `.get()` read
- optional `.get()` chains retain an explicit readonly read of the receiver
  Cell even when a projected result member is observed; this preserves the
  nested Cell in synthesized closure schemas without widening the enclosing
  root to wildcard
- array-like roots whose observed paths only touch non-item properties
  (`length`, `get`, `set`, `key`, `update`) keep array shape but shrink their
  item type to `unknown`
- reads inside an inline array-method callback count as reads of the enclosing
  builder's parameter: the element parameter is bound to the receiver's item
  path, so `table.find((row) => equals(self, row.topic))` records
  `table[].topic` and, through the capture, `self`. The left operand of a `??`
  / `||` fallback resolves to a single source ref, which reaches a root through
  a member/call spine and consumes nothing else; an operand whose spine passes
  through a call is therefore walked as well, covering that call's callback and
  arguments and any call nested in them (`memberSpineContainsCall` in
  `policy/capability-analysis.ts`;
  `test/policy/capability-analysis-array-callbacks.test.ts`). An operand whose
  ref resolves dynamically instead — a computed element-access key, as in
  `table[indexes.findIndex(...)]?.mentionedBy ?? []` — marks the root wildcard,
  which disables shrinking for the whole parameter: its declared shape is
  emitted intact, without the capability wrappers a walked operand would derive
- a tracked value that leaves the body whole, whether named by an identifier
  or by a member expression such as `w.row`, is a full-shape read of its path
  as well as a plain one: returned from an inline callback, put in an array
  literal, projected into an object literal alias resolution cannot follow,
  assigned to anything but a local its own function declares, or handed to a
  callee with no summary, it is read wherever it lands by members the analysis
  never sees, so a member the body did read on the way must not narrow it to
  that member. The left operand of `??` and `||` is the expression's value
  whenever it is there, so it leaves when the expression does. A helper's
  summary carries what the helper let leave whole, and the caller charges it to
  the argument it passed. What a helper returns counts: a function declaration,
  or a function bound to a variable or a property, hands its result straight
  back into the caller's body, so a parameter it returns has left whole. A
  primitive has nothing below it to keep and is left alone. A
  value bound to a local or written into a local collection stays tracked and
  narrows as its reads say. So does a value handed on by reference, which the
  runtime stores as a link so that whatever reads through it does so under a
  schema of its own: an argument to a runtime call (a builder, an applied lift,
  `ifElse`, a cell factory), the payload of a write through a cell (`set`,
  `update`, `send`, `push` and the other writer methods), a JSX prop, and what
  a builder's callback returns, the analyzed one or one lowered inside it.
  `Array.isArray` asks a value's shape and reads nothing below it, so it is not
  an escape either (`wholeValueDestination` / `escapesWhole` in
  `policy/capability-analysis.ts`;
  `test/policy/capability-analysis-whole-value-escapes.test.ts`; the by-reference
  routes are held in place at runtime by
  `packages/patterns/kept-element-references.test.tsx`)
- capability analysis reads through the operand recording an `assert(...)` body
  wraps a method call's receiver in. `AssertDiagnosticsTransformer` (stage 11)
  rewrites `event.details.includes(text)` so that `includes` is called on
  `__cfHelpers.assertCapture(parts, "event.details", event.details)` rather
  than on `event.details`. The recording hands its third argument straight
  back, so the receiver resolves to that argument: the read is charged to
  `event.details`, the field survives the shrink, and cell-likeness is judged
  on the value rather than on the recording helper's untyped result
  (`unwrapAssertCapture` in `utils/expression.ts`;
  `test/assert-diagnostics.test.ts`). Only the receiver is read through. A
  recording in argument position still hides what it wraps from the callee's
  capability contract, so `assert(() => helper(count))` charges `count`
  whatever its own use in the body says, while `computed(() => helper(count))`
  charges it the wrapper capability `helper` declares for that parameter
- node-driven shrinking can still shrink the inner type of cell-like wrappers
  when `.get()` contributes an empty path but coexists with more specific
  non-empty paths
- tuple types and numeric-indexed object types are not rewritten to
  array-with-unknown-items during this optimization
- after shrinking, `validateShrinkCoverage` checks that all requested property
  paths were materialized (see §6.4); unresolvable paths produce hard errors

#### 10.7.1 Identity and comparable-only paths

Capability analysis tracks identity-only use separately from ordinary value
reads/writes so equality and navigation do not force full values into a
computation's input schema:

- Trusted Common Fabric `equals(...)` / `equalLinks(...)` calls record their
  arguments as comparable identity paths. Their cell-like receiver-method forms
  do the same; an arbitrary user object's method merely named `equals` is an
  ordinary read. `navigateTo(...)` records identity (not comparable) argument
  use. Bare helpers are accepted only when symbol resolution proves Common
  Fabric provenance; receiver methods require a cell-like receiver when a
  checker is available (`policy/capability-analysis.ts`,
  `isKnownIdentityArgumentCall`).
- A whole-root identity use records path `[]` and passthrough. `identityOnly` is
  true only when that root identity path survives normalization and the root has
  no non-identity use, ordinary reads/writes, or wildcard. Nested uses populate
  `identityPaths`; cell-like values also populate `identityCellPaths`.
  Comparable use is the corresponding subset in `comparablePaths` /
  `comparableCellPaths`. Local/interprocedural capability summaries and imported
  `ComparableCell` parameter contracts propagate these distinctions.
- Normalization drops a root identity path after non-identity root use, and
  drops any identity path with an ordinary read, full-shape read, write, or
  opaque access at or below that path. Comparable and cell-like subsets are
  pruned with the surviving identity paths. Since #4714, a wildcard records the
  unknown access's static prefix and erases identity/comparable paths that
  overlap it in either direction; disjoint paths survive. A root wildcard still
  suppresses `identityOnly`. This matters because closure captures share one
  synthetic root: blanket erasure degraded disjoint `equals()`-only captures
  into unsatisfiable full-value self-demands
  (`test/policy/capability-analysis.test.ts`).
- Shrinking retains identity paths without materializing their value shape. A
  whole unwrapped identity-only input becomes `unknown`; a wrapped one becomes
  `OpaqueCell<unknown>`, or `ComparableCell<unknown>` for comparable use.
  Identity-only cell leaves receive the same opaque/comparable wrappers, while
  mixed summaries still retain and shrink their ordinary read/write paths
  (`transformers/type-shrinking.ts`; `test/type-shrinking.test.ts`).
- Scheduler completeness is separate from path retention: identity-only roots
  are passthrough, and `hasCompleteSchedulerScopeSummary` rejects passthrough or
  wildcard summaries. Thus identity/comparable tracking can preserve a
  satisfiable input schema without asserting a complete scheduler scope.

#### 10.7.2 Imported capability contracts

Imported cell-wrapper parameter types act as a **capability contract** at call
boundaries (#4486): when a handler passes a cell to a callee whose body lives
in another file, the callee's declared Common Fabric wrapper parameter type
(`Writable<T>` → read+write, `ReadonlyCell<T>` → read, `WriteonlyCell<T>` →
write, etc.) is what capability analysis charges to that argument. Spread
arguments of fixed-length tuple type expand positionally against the callee's
parameter list before matching (#4578). Two write-tracking hardenings
(#4554): `send` is a WRITER_METHOD (`Stream.send()` delegates to `set()` at
runtime, so an event enqueue is a write to the stream cell — previously the
unknown-method fallback recorded it as a read), and an unrecognized method
call on a **cell-like** receiver (type-checked; array/string methods on
`.get()` snapshots are unaffected) marks the parameter's
`hasUnverifiedCellUse` and propagates — the summary fails closed instead of
defaulting to read. When a cell
argument reaches an imported parameter whose capability the contract cannot
classify, the capability would be silently lost, so the transformer reports
**Error** `capability:unreadable-cell-argument`
(`schema-injection.ts:269`, via `reportDiagnosticOnce`). The design narrative
lives in `docs/history/packages/ts-transformers/SCHEMA_INJECTION_NOTES.md`
(a point-in-time design record; "Imported Cell
Parameters Are a Capability Contract").

## 11. Builder Call Hoisting And `__cfReg` Registration

`BuilderCallHoistingTransformer` (stage 19, **after** SchemaInjection) hoists
every reactive *builder call* to module scope and emits a single trailing
content-addressing registration. It is the sole module-scope hoisting phase; it
absorbed the former `LiftHoistingTransformer` (lift-only) and replaced the
deleted `BuilderCallbackHoistingTransformer` (which hoisted builder callbacks
and caused TDZ double-hoist bugs — #3864). Tickets: CT-1644 (lift), CT-1655
(handler, pattern, patternTool), CT-1623 (`__cfReg` content addressing).

### 11.1 What gets hoisted

After SchemaInjection, each reactive builder computation appears in a schema-
injected applied or argument-position shape. This stage relocates the inner
builder call to a named module-scope `const` and rewrites the original site to
reference that name. Three builder shapes are registered in
`HOISTABLE_BUILDERS`:

A module-scope `const` initializer is read through the transparent wrapper set (parentheses, `as`, `<T>x`, `satisfies`, `!`, and partially emitted nodes) before its builder
shape is matched, so a wrapped builder const registers in `__cfReg` on the same
terms as a bare one. A spelling not stripped costs the const its
content-addressed provenance and drops it to the SES source fallback at resolve
time.

- **Applied builders** (`lift`, `handler`): the site is `builder(...)(captures)`
  — the callee is itself the inner `builder(...)` call. Hoist the inner call,
  leave `__cfLift_N(captures)` / `__cfHandler_N(captures)` at the site (any
  trailing `.for(...)` member chain stays anchored on the outer call):

  ```ts
  // Shown inside a pattern body.
  // module scope:
  const __cfLift_1 = __cfHelpers.lift(argSchema, resSchema, callback);
  // original site:
  __cfLift_1(captures).for("result", true)
  ```

- **Argument-position builder** (`pattern`): the bare `pattern(...)` call sits
  in argument 0 of an enclosing `*WithPattern` call (`mapWithPattern`, etc.) or
  `patternTool(...)`. Hoist argument 0 to `__cfPattern_N` and rewrite only that
  argument, keeping the enclosing callee and remaining arguments intact. The
  top-level `export default pattern(...)` is a direct call, not an argument, so
  it is naturally excluded.

Detection is provenance-driven via `detectCallKind` / `isHandlerAppliedCall` /
`getWithPatternHoistablePatternCall` / `getPatternToolHoistablePatternCall`.

### 11.2 Why this runs after SchemaInjection

SchemaInjection derives a lift's argument schema from the adjacent applied
captures object. Hoisting the call to a bare `const = lift(callback)` *before*
injection would separate the captures object and silently drop capture
properties in nested/multi-capture callbacks. Running after injection means the
schema is already baked into the inner call before relocation, so the hoist is
schema-transparent (C-002; verified regression).

### 11.3 Hoist placement and TDZ ordering

Hoisted consts are flushed immediately **before** their owning top-level
statement, not pooled into a single after-imports block. This keeps each hoisted
const after every module binding declared in an earlier statement. The ordering
is behaviorally load-bearing for `pattern`: unlike `lift`/`handler` (callbacks
stored and run lazily), `pattern(...)` invokes its callback **eagerly at
construction**, so a hoisted `const __cfPattern_N = pattern(cb)` whose `cb`
reads a later module-scoped binding would throw a module-load TDZ
`ReferenceError` under after-imports placement.

Hoisted identifiers use explicit per-prefix counters with literal numeric
suffixes (`__cfLift_1`, `__cfPattern_1`, …), **not** `factory.createUniqueName`
— whose `.text` carries only the bare prefix and defers suffixing to emit, which
would make every hoisted identifier share the same `.text` and break the
identity-by-text lookups later stages rely on.

`__cfPattern_<n>` is a **reserved namespace**, and the runner enforces it:
registering an evaluated module (`PatternManager.registerEvaluatedModules`)
refuses a module that EXPORTS a builder artifact under one of these names.
Hoists reach the artifact index through `__cfReg` (§11.4) rather than through
exports, so the reservation costs a compiled module nothing — and it is what
lets a consumer of the index read provenance from the spelling. The
pattern-update gates depend on exactly that: a recorded instantiation named
`__cfPattern_<n>` is derivation the updated source re-runs, and is held to a
different rule than an authored artifact
(`docs/specs/pattern-update-testing.md`). Only artifacts are refused; a plain
value under such a name is inert, since nothing but an artifact is indexable.

### 11.4 `__cfReg` content-addressed registration

After visiting the whole file, the stage appends **one** trailing call:

```ts
// Shown at module scope.
__cfReg({ __cfLift_1, __cfPattern_1, __cfHandler_1, /* … */ });
```

using shorthand properties so each value is the module-level `const` binding
itself. It is emitted only when there is something to register (hoist-free
modules are unchanged). The registered set includes both:

1. the synthetic hoists produced above, and
2. **authored** non-exported top-level builder artifacts — `const foo =
   lift(...)` / `pattern(...)` / `handler(...)` etc. — detected on the original
   statement so an import/alias (`const x = imported`) is never mis-attributed
   to this module's identity.

`__cfReg` is a free identifier supplied by the module wrapper (its 4th factory
parameter, which shadows a no-op `__cfReg` compartment global for any code
outside that wrapper). The runtime registrar pairs each
`{ symbol -> live value }` entry with
the module's content identity, populating the content-addressed reverse index
that backs builder-artifact identity resolution. A single trailing call (rather
than per-artifact export/registration) keeps the runtime verifier's obligation
to "exactly one top-level `__cfReg` call," with a run-once trap rejecting
injected duplicates. Runtime side:
`packages/runner/src/sandbox/module-record-compiler.ts` and
`packages/runner/src/pattern-manager.ts`.

This registration is current, shipped behavior: `__cfReg({...})` appears in the
expected output of the large majority of builder-bearing fixtures.

Note: the design comments frame this stage as Phase 2 of a
"derive→lift→selfcontained" arc. Phase 3 (`selfcontained(...)` wrapping of the
hoisted consts) is **not** implemented on `main` — see the design-deltas doc.

### 11.5 Authored-position lineage at the hoisting boundary

Every builder call this stage visits — hoisted inner calls, in-place authored
builder consts, the `export default` pattern call — and every builder callback
arrives carrying a recoverable **authored** source position (CT-1868). The
carrier is the emit-node **source-map range**: the callbacks
`PatternBuilder.buildCallback`/`buildHandlerCallback` assemble, the closure
strategies' rebuilt applied calls, the expression-rewrite wrapper arrows and
applied calls, and every SchemaInjection builder-call rebuild wrap their
output in `preserveSourceMapRange(built, replaced)` (`src/ast/utils.ts`).
Full `preserveLineage` (textRange + sourceMapRange + original) is applied only
where the emit-invariance gate proved those channels inert — the lift-applied
strategy's outer applied call and the array-method `mapWithPattern` rebuild.

sourceMapRange is the one channel observable only by sourcemaps: a real
`textRange` on a synthetic node changes printer layout (arrow-head
parenthesization via `canEmitSimpleArrowHead`; JSX/ternary line-break reflow),
and a real `original` feeds the §2.2 marker family, `typeRegistry` fallbacks,
and schema derivation — all of which change emitted output. The rebuilds set
no originals, so the `schemaInjected` flag's deliberate lack of a
`getOriginalNode` fallback (§2.2) is unaffected. sourceMapRange also survives
`factory.update*` rebuilds (`setOriginalNode` merges emit-node data,
including `sourceMapRange` — verified on TS 5.9.2 and 6.0.3).

Recovery precedence is: own text range → explicit source-map range →
original-chain terminal. `test/lineage-regression.test.ts` pins it end to end:
it drives the full pipeline over a five-origin fixture and asserts every
builder call AND callback recovers to its distinctive authored snippet
(content is the ground truth, not merely `pos >= 0`). This is the read path
for transform-time source annotation (A′, CT-1870), and the same fallback
family §16.2's coverage spans use. The investigation and probe record is
archived at
`docs/history/packages/ts-transformers/APRIME-LINEAGE-HANDOFF.md`.

The same source-map-range-only rule applies to semantic replacement boundaries
outside the builder-artifact path. Pattern-body reactive-root replacements,
lowered UI-helper elements together with the data attributes they derive from
authored helper props, rebuilt JSX expression containers, rewritten handler
attributes and initializers, nested reactive-array receiver keys, and
module-scope `__cf_data` wrappers all carry the range of the authored node they
replace or wrap. A derived data attribute anchors on the helper prop it
replaces, not on the element carrying it. They deliberately do not acquire that
node's text range or original-node identity.
`test/replacement-source-map-range.test.ts` runs fixtures through the owning
pipeline stage and content-binds every recovered range; it also directly pins
the non-input-bound reactive-wrapper helper branch.

Opaque destructuring uses explicit anchors carried by `DestructureBinding`.
The temporary-root declaration maps to the authored initializer it names;
each lowered leaf declaration maps to its binding element. A prologue statement
created from a destructured callback parameter carries that same binding-element
range. `AssertDiagnosticsTransformer` maps its rebuilt callback body to the
authored concise expression or block, and maps each replacement record block
and `return` to the authored expression or `return` it replaces. These nodes
carry source-map ranges only, so the lineage does not alter printing or checker
identity.

`CFHelpers.preserveNodeSourceMap` requires explicit range and checker-identity
nodes; a caller whose targets coincide passes the same node twice to carry
identity without a text range. Helper names, property accesses, and calls that
need position alone use `preserveSourceMapRange`.
The logical-expression helpers keep their asymmetric authored anchors:
`ifElse` maps to the whole conditional expression, while `when` and `unless`
map to their left condition. The regression binds all three choices to source
content.

That file closes with a corpus-wide invariant: across every fixture, no
synthesized `JsxAttribute`, `JsxElement`, `JsxExpression`, or
`JsxSelfClosingElement` may fail to recover an authored position. Those four
kinds always stand for authored syntax, so a synthesized one is a replacement
that owes a range — which makes the invariant the drift gate for stages added
later. Expression kinds are excluded because injected schemas and hoisting
scaffolds synthesize them with no authored counterpart.

Carried ranges reach the emitted source map for replacements that survive to
emit as themselves. The JSX-shaped replacements above are rebuilt again by
TypeScript's own JSX transform, which runs after this pipeline and does not
propagate emit-node data, so their ranges serve in-pipeline recovery rather
than the emitted map.

### 11.6 Builder source-site sidecar

The hoisting stage consumes that lineage to produce `BuilderSourceSitesV1`, a
versioned, debug-only compiler artifact that travels **beside** emitted
JavaScript. It never injects metadata calls or helper implementations into the
module body. Its wire shape is:

```ts
interface BuilderSourceSitesV1 {
  formatVersion: 1;
  sites: Record<string, {
    line: number; // authored, 1-based
    col: number; // authored, 0-based
    bindingName?: string;
  }>;
}
```

`sites` is keyed by the symbol the verified-evaluation provenance walk uses:
generated hoist names (`__cfLift_1`, `__cfHandler_1`, `__cfPattern_1`),
non-exported authored `__cfReg` names, every namespace export alias, or
`default`. A same-file callback declaration supplies its function position;
inline functions use their own position; a callback reference whose declaration
cannot be recovered falls back to the builder call. `bindingName`, when
recoverable from authored syntax, is the authored declaration name rather than
the generated hoist name.

The compiler caller must opt in with `builderSourceSites.mapSite`, translating
compiler-input positions into authored coordinates before they are recorded.
When the input already is authored source, the caller supplies an explicit
identity mapping. Without a mapper no sidecar is produced; this fails closed
instead of quietly labeling helper-prelude-shifted coordinates as authored.
The runner's mapper removes its injected helper prelude, so cached artifacts
already contain authored coordinates and a source-free warm load needs neither
source text nor a source map to serve them.

The JavaScript compiler exposes the sidecar through
`CompiledTypeScriptModule.builderSourceSites`. Runner module artifacts persist
it with module bytes through the in-memory and cell-backed caches; invalid or
unknown sidecar data is discarded as debug-data loss without affecting module
execution. After verified evaluation, `Engine.#recordModuleProvenance` joins the
module identity, runtime symbol, and source path into
`cf:module/<identity>/<path>:<line>:<col>` and records it in the separate
debug-only `authored-debug-source` `WeakMap`. Lazy `fn.src` and `fn.name`
accessors read that map, resolving a derived factory (`asScope` / `inSpace`)
through to the root the walk recorded. Verified provenance, authorization,
scheduling, and artifact hardening do not read it.

The join happens after a module evaluates, because only the namespace walk
knows which symbol a function was bound to. A diagnostic raised *during* module
evaluation therefore has no authored position available and must name its
subject some other way — the closure-capture diagnostic falls back to the
callback body preview, which is stamped at mint time.

Because this metadata is out of band, every new compiler-artifact transport or
cache must deliberately carry and validate it. Omitting that plumbing is safe
for execution and authority but silently loses debug source fidelity; transport
parity is therefore a maintenance invariant of this design.

This is deliberately separate from the trusted-binding annotation in §17.3.
`__cfBindVerifiedBinding` remains a rare authority-bearing helper emitted only
for `WriteAuthorizedBy` trusted bindings; ordinary transformed patterns do not
carry a repeated source-metadata helper implementation.

## 12. Schema Generation

`SchemaGeneratorTransformer` replaces `toSchema<T>(options?)` calls with JSON
schema literals.

Recognized call forms:

- `toSchema<T>()`
- `__cfHelpers.toSchema<T>()`

Behavior:

1. resolve type from `typeRegistry` (preferred) or checker fallback
2. evaluate literal options object — string, boolean and `null` literals,
   object and array literals, and numbers in any of their spellings (bare
   literal, sign-prefixed, or the `NaN` / `Infinity` globals, the latter only
   where the name is not shadowed). The transparent wrapper set — parentheses
   and the type-only assertion forms `as`, `satisfies`, `<T>x`, `!` — is
   transparent at any depth, including nested inside a sign (`-(1 as number)`).
   A property whose value is none of these is dropped from the options object.

   The code carries a `checker.getConstantValue()` fallback intended to recover
   a named constant or enum member. It runs, but the call returns `undefined`
   for these nodes here (verified for both an `Identifier` and a
   `PropertyAccessExpression`), so `{ maxProperties: K }` and
   `{ maxProperties: E.One }` are both dropped where `{ maxProperties: 1 }`
   survives. Why the checker recovers no constant value at this stage is not
   established here; treat only literal values as supported.
3. extract `widenLiterals` generation option
4. generate schema via a `SchemaGenerator` instance
5. merge non-generation options into resulting schema object
6. report `pattern-result:opaque-reserved-key` when this call describes a
   pattern's result and the generated schema leaves a reserved key opaque at
   its root (§6.12)
7. emit literal as:
   - `<schemaAst> as const satisfies __cfHelpers.JSONSchema`

Special path:

- the generator uses its node-based path when the resolved type is `any` and
  the type-argument node is synthetic (`pos=-1,end=-1`), or when a
  real-position type argument contains any `any` / `unknown` keyword. The
  latter avoids letting the checker recover a wider semantic type and erase
  the authored unknown boundary.
- synthetic union handling preserves `undefined` members (for example
  `string | undefined` retains an explicit `undefined` branch in generated
  schema).
- `unknown` is emitted distinctly as `{ type: "unknown" }`; `any` remains `true`
- arrays of `unknown` emit `items: { type: "unknown" }`
- empty-record defaults emit `default: {}` in pattern argument schemas,
  including inside `Writable`. Both `Record<string, unknown> | Default<V>`
  and `Default<Record<string, unknown>, V>` support `V` written as `{}`,
  `Record<string, never>`, `Record<PropertyKey, never>`, or an alias of any of
  these types, including alias chains and imports
  (`test/default-empty-record-schema.test.ts`). Unresolved default values emit
  `schema-default:unresolved` warnings (§6.12). The extraction rules
  live in §7 of the schema-generator mapping spec.
- the node-based generator analyzes through a `readonly` type operator to
  its wrapped array type. A pattern-scope `.get()` on a `Cell<unknown[]>`
  lowers to a lift with result type `readonly unknown[]` and result schema
  `{ type: "array", items: { type: "unknown" } }`. The derived cell keeps
  this reference-only element schema. The
  `schema-injection/cell-get-readonly-array-result` fixture pins the emitted
  lift schemas, including a `number[]` control.
- the node-based generator also applies the default library's generic
  aliases (`Readonly`, `Partial`, `Required`, `Pick`, `Omit`, `NonNullable`,
  `Array`, `ReadonlyArray`, `Record`) to their arguments, lowers a tuple to an
  array of its element union (`undefined` admitted for an optional element, a
  rest element contributing a spread tuple's elements or an array's items),
  reduces an intersection as the checker reduces the type and merges it as
  the type-based path merges one (the schema-generator mapping spec states
  the rules, among them that `void` is told from an opaque cell wrapper, and
  a nested, named, or union-folded constituent is reopened, by where a
  schema came from; distinct folded unions retain their separate constraints
  even when their schemas coincide), and unwraps parentheses. A pattern-scope
  `.get()` on a `Cell<{ topic: unknown; title: string }>` lowers to a lift
  with result type
  `Readonly<{ topic: unknown; title: string }>` and a result schema that
  keeps both members; a tuple view of `unknown` keeps
  `items: { type: "unknown" }`. The
  `schema-injection/cell-get-unknown-member-result` fixture pins the emitted
  lift schemas, and `schema-injection/intersection-source-types` the
  intersections.
- synthetic unions preserve explicit `{ type: "unknown" }` members in `anyOf`
  rather than collapsing them away
- `Reactive<T>` does not emit an opaque marker. Cell, stream, and opaque
  wrappers all contribute entries to the single `asCell` array (`"cell"`,
  `"stream"`, and `"opaque"`, respectively)
- CFC-specific lowering is implemented behavior at this stage. The canonical
  aliases lower to `ifc.*` metadata through the schema generator;
  `AnyOf<...>` becomes an IFC `anyOf` atom, and `PolicyOf<typeof policy>`
  becomes a policy-reference marker that `SchemaGeneratorTransformer`
  resolves to module identity, symbol, and digest. `WriteAuthorizedBy`
  rehydrates as `ifc.writeAuthorizedBy.__ctWriterIdentityOf = { file, path }`
  (plus a mint-time `moduleIdentity` stamp when the compiler was given
  `moduleIdentities` — see §17.3 file normalization),
  and router-seeded `cfcUiContract` hints emit as `ifc.uiContract`. See §6.8;
  pinned by `test/cfc-authoring.test.ts`,
  `packages/schema-generator/test/schema/cfc-authoring.test.ts`, and
  `test/cfc-ui-helper.test.ts`

### 12.1 Verb Tier Marks (Post-Generation)

`VerbTierMarkTransformer` (stage 21) runs immediately after schema generation,
in the one window where its inference is pure syntax: handler factories are
already hoisted with LITERAL bound-state schemas, the pattern call carries its
generated result-schema literal, and the callback's returned identifiers are
not yet `.for(...)`-wrapped.

Expressions this inference reads — the returned verb and the values it walks
to reach an action — are read through the transparent wrapper set (parentheses, `as`, `<T>x`, `satisfies`, `!`, and partially emitted nodes), so a wrapped verb marks as its bare
form does.

For each `pattern(cb, argumentSchema, resultSchema)` call it marks
result-schema stream properties `tier: "wrapper"` — the verb-listing mark
`cf piece verbs` hides by default (verb contract WS-F; everything stays
callable, `cf piece call` never consults marks). A property is marked when its
returned value resolves (identifier → nearest const initializer, callback body
first then module scope) to an applied handler factory that:

1. binds session-scoped state — the factory's state-schema literal carries
   `scope: "session"` at any depth, OR the application's argument object binds
   a cell the pattern's own schema literals mark session-scoped (explicit
   `handler(...)` factories declare scope-free contexts; the sessionness lives
   in the argument) — **and**
2. takes a **void event** — `false` (lowered no-event `action`s) or an
   opaque-marked object (declared `handler<void, …>`). A wrapper's input IS
   the session draft. This conjunct is a measured narrowing of the specced
   inference: without it the rule marks `topics.addTopic`, the flagship
   headless verb, because it incidentally clears the composer draft after a
   create. A verb with a real event payload that touches a session cell is
   doing its job, not wrapping a UI.

Every hop that does not match leaves the property unmarked — the mark fails
open. Property names are read statically throughout — identifier and
string-literal spellings alike, in the inference and the schema mutation both
— and a computed name is never inferred. The companion mark
`deprecated: true` is produced in the schema
generator itself (`@deprecated` JSDoc on a stream-valued property,
`packages/schema-generator/src/doc-utils.ts`), and both keys are classified
annotation-class in the piece compat checker so they add and remove freely
across pattern updates. Pinned by `test/verb-tier-mark.test.ts` and the
topics patterns' transformed output.

## 13. Reactive Variable `.for()` Naming

`ReactiveVariableForTransformer` (stage 22, first of the five trailing stages
that run on fully lowered, schema-injected output — §3) derives stable,
human-readable **causes** from authored names and attaches them to reactive
values as `.for(<cause>, true)` calls. The cause is the runtime identity seed:
`Cell.for(cause)` stores it on the cell's cause container, and link creation
derives the cell's id from it (`packages/runner/src/cell.ts`, `for()` and the
link-creation path that consumes the stored cause). This stage is what gives
reactive
values deterministic, name-derived identities without authors writing
`.for(...)` by hand: the variable or result-property name *is* the identity
seed.

Like all trailing stages it is gated only on the injected `__cfHelpers` binding
(`HelpersOnlyTransformer.filter`, `src/core/transformers.ts`; injection per
§2.1). It emits no diagnostics; it only rewrites expressions.

### 13.1 The two cause roots

Cause paths originate at exactly two places
(`src/transformers/reactive-variable-for.ts`, `createReactiveVariableForVisitor`):

1. **`const` variable declarations**, anywhere in the module — pattern bodies,
   plain functions, lowered IIFEs. The declared name seeds the path. Conditions
   on the declaration itself: `const` only (`let`/`var` skipped via the
   `NodeFlags.Const` check), the name must be a plain identifier (destructuring
   skipped), it must not start with `__cf` (`isInternalSyntheticName` — this is
   what keeps hoisted `__cfLift_N` consts untagged, §13.6), and there must be an
   initializer.
2. **Pattern results.** For every `pattern(...)` call (recognition:
   `isPatternBuilderCall` in `src/ast/call-kind.ts` — a direct `pattern`
   builder call or any `.pattern` property-access callee, e.g.
   `__cfHelpers.pattern`), the callback's result expression is visited with the
   root path `["__patternResult"]` (`PATTERN_RESULT_CAUSE`). Concise arrow
   bodies and `return` statements in block bodies both count; function-likes
   *nested inside* the callback are recursed plainly, so only the pattern's own
   result gets `__patternResult` causes (consts inside them still get variable
   causes via rule 1).

Everything else is reached by a plain visitor that adds no causes — which is
why object literals built inside e.g. a dynamic `values.map((_, i) => ({...}))`
callback get none (test: "does not add shared property causes inside dynamic
array callbacks").

### 13.2 Which initializers qualify

`shouldAddReactiveFor` decides, with two profiles: variable position
(`shouldAddVariableFor`: `includeRuntimeCalls: true, useTypeFallback: true`)
and nested property/element position (`shouldAddPropertyFor`: both `false`).
After unwrapping non-semantic wrappers (parens, `as`, `satisfies`, `!`,
`<T>x`), the initializer must be a call expression — or a `new` expression
whose constructor is a cell factory (`detectNewExpressionKind`; the
`schema-injection/cell-constructors` fixture shows every `new Cell`-like form
tagged). Bare identifiers, property accesses (`wish(...).result`), literals,
etc. never get a root cause at a declaration.

A qualifying call, per `detectCallKind` (§5) — as of this writing:

- **builder** results, but only when the call is *not* a direct builder call
  (`detectDirectBuilderCall` fails ⇒ the "builder" classification came through
  the factory-result path, i.e. an applied `handler(...)({...})` /
  `__cfHandler_N({...})` site), **or** is a direct `action` / `computed` call
  (`isReactiveBuilderResult`). Direct `lift(...)` / `handler(...)` /
  `pattern(...)` calls — factories, not reactive values — get no cause.
- **cell-factory** (incl. legacy `.of(...)`), **lift-applied**, **ifElse**,
  **when**, **unless**, **wish**, **generate-text**, **generate-object**: yes
  (e.g. `const text = generateText({ prompt: "hi" }).for("text", true)` —
  `jsx-expressions/generate-text-local-ternary.expected.jsx`).
- **runtime-call**: only reactive-origin exports (§5), and only at variable
  position.
- **cell-for** and **pattern-tool**: never (they already carry explicit
  identity / are descriptors; test: "does not re-root pattern factory
  identifiers in tool descriptors").
- **array-method**: only reactive ones — a lowered `*WithPattern` call with
  reactive ownership, or a `map`/`filter`/… whose receiver has reactive
  collection provenance or is itself a qualifying call
  (`isReactiveArrayMethodCall`). Plain array methods over plain data inside
  lift/handler callbacks stay untagged (tests: "does not add causes to plain
  array methods in lift callbacks" / "…in lowered handler callbacks").
- Calls whose callee is a **pattern factory** (`Child({...})` where `Child` is
  a `pattern(...)` result; `isPatternFactoryCalleeExpression`) are excluded
  before all of the above — the sub-pattern instance is not re-caused, though
  reactive values in its argument object still get property causes (test:
  "does not add root causes to pattern factory outputs" pins the absence of
  `.for("child", true)` alongside `.for(["child", "value"], true)`).
- Variable position only, as a last resort: a call whose resolved type is
  cell-like (`isCellLikeType` via `getTypeAtLocationWithFallback`, consulting
  the cross-stage `typeRegistry`).

Suppression: if the receiver chain of the (visited) initializer already
contains a `.for(...)` call — property access `.for` or element access
`["for"]`, walked through call/member chains by `chainContainsForCall` — no
cause is added. Authored `.for("manual")` therefore always wins, at any chain
depth (test: "adds stable variable causes to fresh reactive initializers";
`cell-constructors` keeps authored `.for("name")` verbatim, without the
second argument).

### 13.3 Cause paths for nested values

Within a caused root, the visitor threads a path and tags nested reactive
values (`visitExpressionChildrenWithCausePath`):

- **Object properties** append the property name. Only stable names extend the
  path — identifiers, string/numeric literals, and computed names with literal
  operands (`getStablePropertyName`); `__cf`-prefixed property names and
  non-literal computed names are recursed plainly. Shorthand properties are
  expanded to full assignments when tagged.
- **Array elements** append the numeric index (spreads/holes skipped):
  `.for(["foo", "tuple", 0], true)`.
- **Call arguments** append the argument index — except a *sole*
  object/array-literal argument (after unwrapping, so `f(({ x }) as const)`
  counts), which keeps the parent path. That collapse is why
  `f({ param: Writable.of(1) })` under `const foo` yields
  `.for(["foo", "param"], true)`, not `["foo", 0, "param"]` (tests: "adds
  stable nested causes to constructed variable values", "does not add
  positional cause segments for wrapped single object arguments"). With
  multiple arguments the index appears:
  `__cfHelpers.unless(…schemas…, __cfLift_1({ path }).for(["p", 3], true),
  []).for("p", true)`
  (`jsx-expressions/helper-owned-jsx-iife-captures.expected.jsx`).
- **Member-access receivers** are descended with the same path but never get a
  mid-chain root cause (test: "does not add causes to receiver calls in
  property access chains" — no `.for("mentionable", true).result`).
- Once a root is tagged, its call arguments are **not** descended
  (`skipCallArguments`), and a transparent wrapper is tagged whole without
  descending: `(__cfHelpers.ifElse(...)).for("tree", true) as Entry[]`
  (`jsx-expressions/helper-owned-jsx-iife-default-input-local-chain-map-capture.expected.jsx`).
  Combined with the chain check this yields exactly one cause per value even
  under casts (test: "does not duplicate stable causes on asserted reactive
  initializers").

A pattern whose result is a single reactive call gets the bare root cause:
`return __cfLift_1({ input }).for("__patternResult", true)`
(`schema-transform/pattern-explicit-types.expected.jsx`). The canonical
object-result shape (`ast-transform/pattern-object-binary-add.expected.jsx`):

```ts
// Shown for illustration only.
// Shown inside a pattern body, after lowering + hoisting.
export default pattern((state) => ({
    next: __cfLift_1({ state: { count: state.key("count") } })
        .for(["__patternResult", "next"], true)
}), /* argument schema */, /* result schema */);
```

### 13.4 Reactive identifier re-rooting

Inside object-literal properties (only there), a *reference* to an existing
reactive value is re-caused at its result location: after visiting, a bare
identifier whose type is a branded cell or cell-like — or, absent type
information, is a reactive value expression (`isReactiveValueExpression`) —
gets `.for(<path>, true)` appended (`shouldRetargetReactiveReference`). The
cause names the property, not the referenced binding:

```ts
// Shown inside a pattern body.
// (test: "re-roots reactive identifier members in pattern results")
const foo = Writable.of(1, /* schema */).for("foo", true);
return {
    foo: foo.for(["__patternResult", "foo"], true),
    explicit: foo.for(["__patternResult", "explicit"], true),
};
```

Pattern-factory identifiers are exempt (`isPatternFactoryHelperExpression`),
and retargeting is disabled inside arguments of pattern-factory /
pattern-builder calls (`shouldPreserveStructuralCallArgumentReferences`), so
`{ pattern: searchWeb }` descriptors and `patternTool(searchWeb)` stay
untouched. Plain (non-cell) identifiers such as string handler params are
never retargeted (test: "does not retarget plain handler params inside local
object initializers").

### 13.5 Emitted cause grammar

`createForCall` / `createCauseExpression` emit `.for(<cause>, true)` where the
cause is:

- a **string literal** for variable names and single-segment paths
  (`["tree"]` collapses to `"tree"`; likewise `"__patternResult"`);
- an **array literal** of string/numeric literals for longer paths:
  `["__patternResult", "nested", "bar"]`, `["foo", "tuple", 0]`;
- a **`{ stream: <cause> }` object** when the tagged expression is a
  handler/action builder result or has a `Stream`-like type
  (`shouldUseStreamCause`; the type check matches a symbol or alias named
  `Stream` on any union/intersection part). Applied handlers and lowered
  `action`s therefore get `.for({ stream: "save" }, true)` /
  `.for({ stream: ["__patternResult", "readA"] }, true)`
  (test: "uses stream-scoped causes for handler result streams";
  `closures/action-partial.expected.jsx`), and `new Stream.perSpace<Event>(…)`
  gets `.for({ stream: "event" }, true)` (`cell-constructors`).

The second argument is always the literal `true` — the runtime's `allowIfSet`
flag: the synthetic cause is a *suggestion*, silently ignored if the cell
already has a cause or link, whereas authored one-argument `.for(cause)`
throws in that case (`packages/runner/src/cell.ts`, `for(cause, allowIfSet?)`).
Source-map ranges are
preserved from the original initializer (`preserveNodeSourceMap`).

### 13.6 Ordering and the hoisting interplay

Running at stage 22 means causes are derived from the final lowered shape:
`computed`/`action`/JSX expression sites have already become lift/handler
applications and IIFE-local consts (stages 9–14), schemas are injected and
generated (18, 20), and builder calls are hoisted (19). Two concrete
dependencies on `BuilderCallHoistingTransformer` (§11):

- Hoisted module-scope consts are named `__cfLift_N` / `__cfHandler_N` /
  `__cfPattern_N`, so the `__cf` name filter (§13.1) keeps this stage from
  tagging the hoisted declarations themselves — the *authored* name at the
  application site is what becomes the cause
  (`const isFolder = __cfLift_1({ kind: kind }).for("isFolder", true)`).
- The synthetic site `__cfLift_N(captures)` has a callee identifier the
  checker cannot resolve. Hoisting stamps the hoisted inner call as the
  identifier's original node precisely so that `detectCallKind` still
  classifies the application (lift-applied, or `builderName: "handler"`) "for
  downstream stages — notably ReactiveVariableFor's `.for(...)` /
  stream-cause attachment" (`src/ast/call-kind.ts`, hoisted-builder fallback;
  `src/transformers/builder-call-hoisting.ts` original-node stamping and
  member-chain anchoring comments).

### 13.7 Behavioral consequences

Stated plainly, because pattern authors observe them:

- **Renaming re-keys.** The cause is literally the lexical name
  (`declaration.name.text`) or result path. Renaming a `const` or a result
  property changes the emitted cause, and with it the link id the runtime
  derives from that cause — the value continues under a new identity.
- **No uniquification.** Unlike the hoisting stage's numbered `__cfLift_N`
  names (§11.3), causes carry no counters or scope qualifiers: two `const x =
  cell(...)` declarations in different scopes emit the identical cause `"x"`.
  Disambiguation is the runtime's concern (causes seed id derivation together
  with the creating context — `packages/runner/src/cell.ts`).
- **Authored identity always wins** — twice over: an authored `.for` in the
  receiver chain suppresses emission entirely (§13.2), and even an emitted
  suggestion is a no-op at runtime against any already-set cause or link
  (`allowIfSet`, §13.5).

The emitted-shape contract is pinned primarily by the "adds stable … causes"
/ "does not add …" tests in `test/transform.test.ts`; the fixture corpus
(§20) then shows the same shapes end-to-end.


## 14. Module-Scope Shadow Guards

`ModuleScopeShadowingTransformer` (stage 23,
`src/transformers/module-scope-shadowing.ts`) inserts one module-scope
`const <name> = undefined;` declaration for each name in
`SHADOWED_FACTORY_BINDINGS` — as of this writing `define`, `runtimeDeps`, and
`__cfAmdHooks` (`packages/utils/src/sandbox-contract.ts`). These are
module-loader binding names: declaring each as `undefined` at module scope makes
loader machinery unreachable from authored/compiled pattern code even if a
binding of that name were ever in scope around a module body. The stage landed
with the SES-default sandbox (#3168) and is shared vocabulary with the runner's
sandbox verifier via `@commonfabric/utils/sandbox-contract` (see §14.4).

No such binding reaches a module body today. The module wrapper supplies
`exports`, `require`, `module`, and `__cfReg` as parameters and nothing else, and
none of the shadowed names is a compartment global
(`packages/runner/test/security.test.ts`, "does not expose loader machinery on
the module compartment globals", compiles a probe that reads
`globalThis.define`, `globalThis.require`, `globalThis.runtimeDeps` and
`globalThis.__cfAmdHooks` and asserts every one is `"undefined"`). The guards are
therefore defense-in-depth, and they are byte-pinned across effectively the whole
fixture corpus (§14.5).

### 14.1 Trigger conditions

None — the stage is unconditional. It extends `Transformer` directly and does
not override `filter()` (the default returns `true`;
`src/core/transformers.ts`), unlike helper-gated stages such as
`ModuleScopeCfDataTransformer`, which extends `HelpersOnlyTransformer`. Every
source file the pipeline visits receives the guards, including:

- files with no Common Fabric imports or builders at all, and
- **function-free** files, where the guards are the only synthetic addition; a
  file with top-level functions also gets stage-26 hardening (§17).

The stage reads no cross-stage state and never reports diagnostics: its
`transform()` touches only `context.factory` and `context.sourceFile`.

### 14.2 Exact emission and placement

For each name in `SHADOWED_FACTORY_BINDINGS` (in array order), the stage builds
a `const` variable statement whose initializer is the *identifier* `undefined`
(`factory.createIdentifier("undefined")`, `ts.NodeFlags.Const`). The guard
block is spliced in after the file's **leading contiguous run of import
declarations**: `findFactoryGuardInsertionIndex` walks statements from index 0
while `ts.isImportDeclaration` holds and inserts at the first non-import
(index 0 for an import-free file). Imports that appear *after* the first
non-import statement stay where they are and do not move the guards.

```ts
// Shown for illustration only.
// Input (after earlier stages):
import { __cfHelpers } from "commonfabric";
import { handler, Cell } from "commonfabric";
interface CounterEvent { increment: number }
// …

// Output of this stage:
import { __cfHelpers } from "commonfabric";
import { handler, Cell } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface CounterEvent { increment: number }
// …
```

(This is the layout pinned by e.g.
`test/fixtures/handler-schema/simple-handler.expected.jsx`.)

The emitted text matches `createFactoryShadowGuardSource()`
(`packages/utils/src/sandbox-contract.ts`), which renders the same list as
`const ${name} = undefined;` strings — the canonical byte form the runner-side
verifier compares against (§14.4). The transformer performs no dedupe or
collision check: it does not look for existing declarations of the guard names
before inserting.

### 14.3 Ordering (why stage 23)

The stage sits in the trailing module-scope emission group (23
`ModuleScopeShadowing`, 24 `ModuleScopeCfData`, 26
`ModuleScopeFunctionHardening`), which runs after lowering and schema work is
complete (§3). It is purely syntactic — no checker, `typeRegistry`, or
capability state — so no output from schema generation (stage 20) feeds it;
conversely the
later module-scope stages leave the guards untouched: `ModuleScopeCfData` never
wraps them (`undefined` is not a data candidate — every guard appears verbatim
in fixture output) and `ModuleScopeFunctionHardening` *prepends* its helper
declarations at position 0, which is why final output reads
`__cfHardenFn…, imports…, guards…, body` rather than guards-first. The exact
stage position is pinned by the stage-order regression
(`test/pipeline-regressions.test.ts`, "CFC transformer stages stay in the fixed
order") and is behaviorally significant only in that coarse sense (invariant
C-002); no code comment claims a tighter adjacency constraint, and hoisted
builder consts (§11.3) land after the guards simply because their owning
statements do.

### 14.4 Cross-package sandbox contract

The guard names and byte form are one leg of the compile-time/runtime sandbox
contract, analogous to §11.4's `__cfReg` pairing:

- **Shared constants** — `SHADOWED_FACTORY_BINDINGS`,
  `RESERVED_FACTORY_BINDINGS` (currently the same list), and
  `createFactoryShadowGuardSource()` live in
  `packages/utils/src/sandbox-contract.ts` and are imported by both the
  transformer (`module-scope-shadowing.ts`) and the runner verifier
  (`packages/runner/src/sandbox/compiled-bundle-verifier.ts`).
- **Verifier mechanism** — `classifyModuleItems` (the format-agnostic SES
  module-item classifier in `compiled-bundle-verifier.ts`) takes
  `ModuleItemClassificationOptions` with `requiredGuards` (normalized guard
  statements that MUST all be present) and `reservedBindings` (names authored
  code may not declare, else "Reserved wrapper binding '<name>' is not allowed
  in SES mode", `assertFactoryBindingIsNotReserved`).
- **The live path passes empty sets, and must** — `verifyCompiledModuleBody`
  (`packages/runner/src/sandbox/module-record-verifier.ts`) calls the
  classifier with `requiredGuards`/`reservedBindings` both empty, since no
  wrapper binding reaches a module body to shadow. The emitted guards are
  therefore neither required nor reserved; each verifies as an ordinary
  primitive `const` (`undefined` classifies as `{ kind: "data" }` in
  `classifyExpressionText`).
  The empty set is load-bearing rather than a stub: `RESERVED_FACTORY_BINDINGS`
  is exactly `SHADOWED_FACTORY_BINDINGS`, so reserving those names would reject
  every transformed module **on its own guards**. That is why
  `RESERVED_FACTORY_BINDING_SET` is exported for a caller to pass explicitly but
  is deliberately not a parameter default anywhere — a default would silently
  enable the check that rejects transformer output. Pinned by
  `packages/runner/test/module-item-classifier.test.ts`, "the canonical reserved
  set would reject the transformer's own shadow guards", which runs
  `createFactoryShadowGuardSource()` output through the classifier under both
  configurations.
- **Runtime invariant** — the loader-agnostic guarantee is that no loader
  machinery reaches the module compartment's global surface
  (`packages/runner/test/security.test.ts`, "does not expose loader machinery on
  the module compartment globals").
- **Tooling consumer** — `cf view` classifies the three names as "module
  scaffolding" for syntax coloring via its own hard-coded copy of the list
  (`packages/cli/lib/view/languages/typescript/vocab.ts`, `SCAFFOLDING_NAMES`), which can drift from
  `SHADOWED_FACTORY_BINDINGS` since it does not import it.

Net: on current `main` the emission is a one-directional contract — the
transformer must keep emitting statements the verifier *accepts* (primitive
consts), but no runtime component fails if the guards disappear. The fixture
corpus, not the verifier, is what pins them today.

### 14.5 Edge cases pinned by tests

- **Corpus-wide emission**: as of this writing every active
  `*.input.*`/`*.expected.*` fixture pair pins the guard block byte-for-byte
  (exact counts churn and are intentionally not pinned here — see the
  test-coverage section). The only expected files without guards are inert:
  `closures/map-generic-type-parameter.*` is `.skip`-suffixed and
  `closures/map-type-assertion.expected.jsx` has no `.input.*` partner, so the
  driver never exercises it.
- **Placement after the import block**: pinned by every fixture with leading
  imports (e.g. `handler-schema/simple-handler.expected.jsx`: guards
  immediately after the two imports, before the first interface).
- **Guards precede hoisted builder consts**: fixtures with hoists show
  `imports → guards → … → __cfLift_N/__cfPattern_N consts before their owning
  statements` (§11.3 interplay).
- **Not pinned by committed tests** (verified only by direct probe as of this
  writing): insertion after only the *first* contiguous import run when imports are
  interleaved with statements; behavior when authored code already declares a
  guard name at module scope (no collision check exists in the transformer).


## 15. Module-Scope `__cf_data` Wrapping (SES Plain-Data Snapshots)

`ModuleScopeCfDataTransformer` (stage 24,
`src/transformers/module-scope-cf-data.ts`) wraps qualifying module-scope
initializers and default exports in `__cfHelpers.__cf_data(...)`. The wrap
exists for the runner's SES sandbox: the module verifier only admits top-level
values it can classify as `builder | data | function | import`, and rejects raw
mutable literals and arbitrary call results at module scope
(`classifyExpressionText`,
`packages/runner/src/sandbox/compiled-bundle-verifier.ts`; policy narrative in
`docs/specs/module-loading.md` §"Security
classification"). `__cf_data(...)` is the canonical "verified module-safe
data" wrapper of that grammar: the verifier pattern-matches the wrapper
boundary without interpreting the payload, and at module load the runtime
helper — `__cf_data` is bound to `freezeVerifiedPlainData`
(`packages/runner/src/builder/factory.ts`,
`packages/runner/src/sandbox/plain-data.ts`) — validates the value that
survives load and deep-freezes it into an inert snapshot
(`docs/specs/sandboxing/SES_SANDBOXING_SPEC.md` §4.2.3, §4.2.6). At the type
level the helper is an identity function (`CfDataFunction = <T>(value: T) =>
T`, `packages/api/index.ts`), so wrapping does not perturb inference.

The stage extends `HelpersOnlyTransformer` (`src/core/transformers.ts`), so it
runs when the injected `__cfHelpers` import is present, which §2.1 makes true
of every source the pipeline compiles. Introduced when SES
became the default runner sandbox (#3168, originally emitting `__ct_data`;
renamed with the Common Fabric compatibility-layer removal, #3252); the
default-export callable rule below was added by the SES default-export
builder-check fix (#3315).

### 15.1 Trigger conditions

Only two top-level statement kinds are inspected
(`transformTopLevelStatement`); everything else — expression statements
(including the trailing `__cfReg({...})` from §11), function/class
declarations, imports — passes through unchanged:

1. **`const` variable statements** (any declarator with an initializer;
   `let`/`var` lists are skipped via the `NodeFlags.Const` check — the verifier
   independently rejects non-`const` module state, per
   `module-loading-verifier-and-engine-design.md`). Export modifiers are
   irrelevant to the check and preserved.
2. **Export assignments** (`export default expr`) — same predicate, plus the
   default-exported data-callable rule (§15.3).

An initializer is wrapped when `shouldWrapTopLevelExpression` accepts it.
First, two negative gates: initializers asserted to `any`/`unknown` (`as any`,
`<unknown>expr`, including parenthesized forms) are never wrapped
(`isAnyLikeTypeAssertion`), and arrow functions, function expressions, and
class expressions are never wrapped (functions are stage 26's business, see
§15.4). Classification then looks through non-semantic wrappers —
parentheses, `as`, `satisfies`, `!`, angle-bracket assertions
(`unwrapExpression`, `src/utils/expression.ts`) — while the emitted wrap
encloses the original expression, wrappers included:

- **Call expressions.** Excluded first: calls whose callee names a trusted
  builder — `action`, `computed`, `derive`, `handler`, `lift`,
  `multiUserTest`, `pattern` (`isTrustedBuilder`,
  `@commonfabric/utils/sandbox-contract`). Matching is name-based
  (`hasNamedTarget`): a bare identifier or the terminal property name
  (`__cfHelpers.lift`), not §5 provenance detection. Otherwise a call is
  wrapped when any of these arms match:
  - trusted data-helper call: `schema`, `__cf_data`, `nonPrivateRandom`,
    `safeDateNow` (`isTrustedDataHelper`, same module);
  - immediately-invoked function expression (`isImmediatelyInvokedFunction`);
  - `Array.from(...)` or `Object.fromEntries(...)`
    (`isIntrinsicCtDataCall`);
  - call to a local top-level callable — a top-level function declaration or
    `const` arrow/function-expression binding
    (`collectTopLevelCallableBindings`, `isTopLevelLocalHelperCall`);
  - bare-identifier call whose checker-resolved result type is
    primitive-like — String/Number/Boolean/BigInt-like, `null`, `undefined`,
    `void`, and unions/intersections thereof (`isPrimitiveSnapshotCall`,
    `isPrimitiveLikeType`);
  - any call whose callee is a property access (`receiver.method(...)`).
- **`new` expressions.** Only `new Map(...)` and `new Set(...)`
  (`CF_DATA_CONSTRUCTOR_NAMES`). Notably `new Proxy(...)` is left unwrapped —
  "Proxy snapshots stay unsupported until Proxy is re-enabled in SES
  compartments" (`test/transform.test.ts`, "wraps top-level data candidates
  with __cfHelpers.__cf_data").
- **Literals.** Regular-expression literals, object literals, and array
  literals are always wrapped.
- Everything else — identifier references, primitive literals, template
  literals, property accesses — is not wrapped; the verifier classifies
  primitive-like initializers as data without a wrapper
  (`isPrimitiveLikeExpression`, `compiled-bundle-verifier.ts`).

If no declarator or export changed, the source file is returned unmodified.

### 15.2 Emission

`wrapWithCfData` emits a call to the `__cf_data` property of the injected
helpers binding, with the original initializer as sole argument. The authored
callee is not rewritten — only circumfixed (`test/transform.test.ts` asserts
`safeDateNow()` wraps to `__cfHelpers.__cf_data(safeDateNow())` and that
`__cfHelpers.safeDateNow` never appears):

```ts
// Shown for illustration only.
// Authored (module scope):
const model = schema({ type: "string" } as const);
const days = Array.from({ length: 3 }, (_, i) => String(i + 1));
const matcher = /^[a-z]+$/;
const tags = new Set(["a", "b"]);
const passthrough = lift((value: string) => value);

// After stage 24 (abridged from test/transform.test.ts):
const model = __cfHelpers.__cf_data(schema({ type: "string" } as const));
const days = __cfHelpers.__cf_data(Array.from({ length: 3 }, (_, i) => String(i + 1)));
const matcher = __cfHelpers.__cf_data(/^[a-z]+$/);
const tags = __cfHelpers.__cf_data(new Set(["a", "b"]));
const passthrough = lift((value: string) => value); // builder call — excluded (hoisted/registered per §11)
```

The most common wrap in fixture output is the schema literal §12 materializes:
`toSchema<T>()` becomes `{...} as const satisfies __cfHelpers.JSONSchema`,
which stage 24 then wraps whole — assertions preserved inside the call:

```ts
// Shown at module scope.
const configSchema = __cfHelpers.__cf_data({
  type: "object",
  /* … */
} as const satisfies __cfHelpers.JSONSchema);
```

(`test/fixtures/schema-transform/with-options.expected.jsx`; a
default-exported object literal wraps the same way:
`export default __cfHelpers.__cf_data({ logPiecesList, getStatus });` in
`test/fixtures/ast-transform/lift-explicit-toschema.expected.jsx`.) The wrap
appears across dozens of expected fixtures; grep `__cf_data` under
`test/fixtures/` for current coverage.

Wrapping a helper that already freezes (e.g. `schema(...)`, which the runtime
binds to the same freezer — `packages/runner/src/builder/factory.ts`) is
redundant but harmless: `freezeVerifiedPlainData` short-circuits on
already-verified values via the `verifiedPlainData` WeakSet
(`packages/runner/src/sandbox/plain-data.ts`).

### 15.3 Default-exported call-result wrappers (deliberate load failure)

`export default helper` is additionally wrapped when `helper` is a local
top-level callable whose body may return a **call applied to another call
result** — the `factory()()` shape — including when that expression is nested
inside a returned object/ternary, and stopping at nested function/class
boundaries (`collectDefaultExportedDataCallables`,
`callableMayReturnCallResult`, `isCallOnCallResultExpression`; positive and
negative cases in `test/module-scope-cf-data.test.ts`). Emission:
`export default __cfHelpers.__cf_data(helper)`.

This wrap is not a snapshot — it is a **rejection**. `freezeVerifiedPlainData`
throws `Unsupported value type 'function'` on callables
(`packages/runner/src/sandbox/plain-data.ts`), so the module fails at load.
That is asserted end-to-end: the runner engine tests compile such a module,
check the emitted `__cf_data(ChildManager)`, and expect evaluation to reject
with exactly that error (`packages/runner/test/engine-evaluate-record-graph.test.ts`, "wraps
default-exported call-result wrappers in __cf_data" and "wraps nested and
branched default-exported call-result wrappers"). Rationale (#3315): a plain
function that forwards a builder-factory instantiation (e.g.
`function ChildManager(input) { return makeWrapper(Child)(input); }`) would
otherwise classify as an allowed direct-function default export and carry
builder call results past the verifier's default-export rule; the wrap turns
that shape into a deterministic load-time failure, while default-exported
functions that only call plain local helpers stay allowed and callable
(`engine-evaluate-record-graph.test.ts`, "allows default-exported functions that call plain local
helpers"). Relatedly, nothing `__cf_data` produces can launder builder trust:
trust-requiring sites check the trusted brand, not the structural shape
(`packages/runner/src/builder/pattern-metadata.ts`,
`packages/runner/src/pattern-manager.ts`).

### 15.4 Why stage 24

- **After `SchemaGeneratorTransformer` (stage 20):** materialized schema
  literals are object literals at module scope; running after materialization
  is what gets them wrapped (§15.2 fixtures). Before it, the authored
  `toSchema<T>()` call matches no wrap arm, so the literal would reach the
  verifier raw and be rejected as mutable top-level data.
- **After `BuilderCallHoistingTransformer` (stage 19):** the hoisted
  `const __cfLift_N = __cfHelpers.lift(...)` consts exist by stage 24 and are
  excluded by the trusted-builder arm; the trailing `__cfReg({...})` call is
  an expression statement and out of scope (§15.1).
- **Before `ModuleScopeFunctionHardeningTransformer` (stage 26):** hardening
  rewrites top-level function initializers to `__cfHardenFn(...)` calls and
  declares `__cfHardenFn` as a top-level function. Had cf-data run afterwards,
  those calls would match the local-helper-call arm and function values would
  be mis-wrapped into throwing `__cf_data` snapshots. (Derived from
  `isTopLevelLocalHelperCall` plus the hardening emission; no dedicated
  regression test pins this ordering.)
- The relative order against `ModuleScopeShadowingTransformer` (stage 23) is
  not observably load-bearing: the shadow guards' `undefined` initializers
  match no wrap arm (derived; guards in
  `src/transformers/module-scope-shadowing.ts`).

The stage order itself is pinned by the §3 regression
(`test/pipeline-regressions.test.ts`, "CFC transformer stages stay in the
fixed order").

### 15.5 Verifier contract (cross-package, normative)

The emitted shape is one half of a pattern-matched contract with the runner's
SES module verifier; the shared vocabulary lives in
`@commonfabric/utils/sandbox-contract` (`TRUSTED_BUILDERS`,
`TRUSTED_DATA_HELPERS`, `isTrustedBuilder`, `isTrustedDataHelper`), which both
the transformer (`src/transformers/module-scope-cf-data.ts` imports) and the
verifier (`packages/runner/src/sandbox/policy.ts` re-exports) consume. On the
verifier side (`packages/runner/src/sandbox/compiled-bundle-verifier.ts`):

- raw mutable initializers — normalized text starting `{`, `[`, `/`, or `new`
  (`isRawMutableExpression`) — are rejected with "Mutable top-level data must
  be wrapped in __cf_data() in SES mode";
- calls to local functions or untrusted imports are rejected with "Top-level
  call results must be wrapped in __cf_data() in SES mode"
  (`TOP_LEVEL_CALL_RESULT_ERROR`, `policy.ts`); IIFEs are likewise rejected
  outside a `__cf_data` argument;
- a `__cf_data` call must have **exactly one argument**
  (`verifyTrustedDataCall`) and its callee must resolve through a trusted
  runtime binding — an import binding whose `trustedRuntimeName` is a trusted
  data helper, or a member chain off the runtime namespace import, including
  the compiled `commonfabric_1.__cfHelpers.__cf_data` two-property form
  (`resolveTrustedCallName`);
- an accepted call classifies the binding as kind `"data"`, which is an
  allowed default export ("Default exports must be trusted builders, direct
  functions, verified data, or import re-exports").

The verifier checks the wrapper boundary and call shape only — it does not
interpret the payload; load-time enforcement is the runtime freezer, which
admits the module-safe subset (plain objects, arrays, `Map`→`FrozenMap`,
`Set`→`FrozenSet`, non-global/non-sticky RegExp, primitives/bigint) and throws
`PlainDataValidationError` on everything else
(`SES_SANDBOXING_SPEC.md` §4.2.3; `packages/runner/src/sandbox/plain-data.ts`).
That classification runs on each per-module record body, through
`verifyCompiledModuleBody` (`classifyModuleItems` doc comment;
`docs/specs/module-loading.md` §"Security classification"). Write-once module
exports neutralize side effects smuggled into an accepted wrapper
argument (`__cf_data((exports.x = evil, 1))`), and pipeline-compiled bodies are
required precisely because bare `ts.transpileModule` cannot produce the
`__cf_data` wrapping (`packages/runner/src/sandbox/module-record-compiler.ts`).

### 15.6 Alternate wiring (`__cfDataHelper`), removed — historical

Until the 2026-07 docs audit the transformer and `CFHelpers` retained a
second, data-helper-only emission path from the opt-in era (#3168), when
modules without a `/// <cts-enable />` directive received only a
`__cf_data as __cfDataHelper` import from the runner's pretransform (via a
string-pass `injectCfDataHelper` helper): with `__cfHelpers` absent,
`wrapWithCfData` fell back to that import binding or a bare `__cfDataHelper`
identifier plus a prepended import, and `shouldWrapTopLevelExpression`
narrowed to primitive-snapshot calls only. The wiring became unreachable when
transforms went default-on (#3254 removed the pretransform call site; the
`HelpersOnlyTransformer` filter guarantees `sourceHasHelpers()` at every wrap
site) and its output had drifted out of contract — `__cfDataHelper(...)` is
not in `TRUSTED_DATA_HELPERS`, so the sandbox verifier would not classify the
fallback's wraps. The audit removed the whole path: `injectCfDataHelper`, the
fallback emission arms, `createCfDataHelperImport`, and the
`getDataHelperExpr` / `sourceHasDataHelper` recognizer surface.
`wrapWithCfData` now has the single §15.2 emission form, and `getHelperExpr`
throws if the filter invariant is ever violated (pinned in
`test/module-scope-cf-data-coverage.test.ts`). `test/transform.test.ts` once
asserted `__cfDataHelper` absent from opted-out output; #4463's
structural-assertion rewrite already dropped that literal check, and after
this removal no code in the package references the identifier at all.


## 16. Pattern Runtime Coverage Instrumentation

`PatternCoverageTransformer` (stage 25) injects statement-level coverage
counters into authored runtime code. It is off by default and is the only
stage gated on a harness-supplied option rather than on source content: its
`filter` requires `TransformationOptions.patternCoverage` to be set and the
file not to be a declaration file, and a filtered-out stage returns the source
file untouched (`Transformer.toFactory`, `src/core/transformers.ts`). Nothing
inside this package ever sets the option; it exists for the runner's `cf test`
pattern-coverage mechanism described in `docs/development/COVERAGE.md`.

### 16.1 Enablement and plumbing

`TransformationOptions.patternCoverage?: PatternCoverageOptions`
(`src/core/transformers.ts`) has three members: a required
`registerSpan(span)` sink, an optional `fileName(sourceFileName)` remap, and
an optional `mapSpan(span)` that may rewrite a span or veto it by returning
`undefined` (a vetoed span is neither registered nor counted — no hit
statement is emitted for it).

The option is constructed end-to-end by the runner/CLI chain:

1. `cf test` resolves a coverage directory from the `--pattern-coverage-dir`
   flag, falling back to the `CF_PATTERN_COVERAGE_DIR` environment variable
   (`packages/cli/commands/test.ts`). Per `docs/development/COVERAGE.md`, that
   variable is read in exactly this one place — jobs running plain `deno test`
   or talking to a Toolshed server never reach this code, so setting it there
   has no effect.
2. The test runner builds one `PatternCoverageCollector` per test file and
   passes it as the `patternCoverage` harness option to
   `engine.compileAndEvaluateModules` (`packages/cli/lib/test-runner.ts`; the
   option is declared as a module augmentation of
   `TypeScriptHarnessProcessOptions` in
   `packages/runner/src/pattern-coverage.ts`). Multi-user tests instead build
   one collector per participant inside each worker and suffix the output
   filename with the participant name
   (`packages/cli/lib/multi-user-test-worker.ts`); the orchestrating runner
   disables its own local write for those tests.
3. The engine wraps the collector into the actual `PatternCoverageOptions` —
   `registerSpan` forwards to the collector, `fileName`/`mapSpan` implement
   the filename and line remapping of §16.5
   (`patternCoverageOptionsForCompile`,
   `packages/runner/src/harness/engine.ts`) — and hands it to the
   `CommonFabricTransformerPipeline({ patternCoverage })` it constructs for
   the compile.

### 16.2 What gets instrumented

Instrumentation is statement-based: one span is registered per instrumentable
statement (or body), and a *hit statement* is inserted immediately before it.
Reaching the statement marks the span's whole source range as run
(`docs/development/COVERAGE.md`).

Statement lists visited for per-statement counters (`instrumentStatements`):
source-file top level, `Block`, `ModuleBlock` (i.e. bodies of namespaces that
survive erasure), class static blocks, and `case`/`default` clause statement
lists. An empty fall-through `case`/`default` clause gets a clause-level span
so reaching the label is still recorded (`visitCaseOrDefaultClause`; test
"empty fall-through switch case is recorded").

`shouldInstrumentStatement` excludes statements with no runtime effect of
their own: `declare`-modified statements, function declarations and class
declarations (their *bodies* are still instrumented), interfaces, type
aliases, `const enum`s, namespaces that erase entirely (checked recursively
by `isErasedModuleDeclaration`, including nested and dotted forms), and
import/export declarations. Fully type-erased statements are not even
descended into (`instrumentStatements` skips `visit` for them). Directive
prologues stay first: at the source-file top level and in function-like block
bodies, `"use strict"` strings keep their position and hit statements are
inserted after the prologue (`isDirectiveStatement`,
`preserveDirectivePrologue`; a leading *non-directive* string statement is
instrumented normally — both behaviors pinned in
`test/pattern-coverage-transformer.test.ts`).

Beyond statement lists, `visit` instruments:

- **Function-like bodies** — arrow functions, function
  declarations/expressions, methods, constructors, and get/set accessors
  (`visitFunctionLike`). An expression-bodied arrow is rewritten to a block:
  `x => expr` becomes `x => { <hit>; return expr; }`
  (`instrumentConciseBody`).
- **Braceless control-flow bodies** — `if`/`else` branches
  (`visitIfStatement` / `instrumentStatementBody`) and
  `do`/`while`/`for`/`for-in`/`for-of` bodies (`wrapVisitedStatementBody`)
  are lifted into synthetic blocks carrying the hit statement, so single-line
  forms like `if (flag) doThen();` record branch execution (test
  "single-statement control-flow bodies are wrapped and recorded").

Span positions are 1-based line/column ranges resolved against the authored
source file via `sourceRangeForSpan`, which falls back from the node to
`ts.getOriginalNode(node)` and then to the node's source-map range — so
statements rebuilt as synthetic nodes by any of the 20 earlier stages still
report their authored location (test "statements rebuilt as synthetic nodes
still get coverage"). A statement whose position cannot be recovered is left
uncounted rather than mislocated. Span ids count up from 1 per source file;
`kind` is always `"runtime"`, the sole member of `PatternCoverageKind`
(`src/core/transformers.ts`).

### 16.3 Emitted shape

Each counter is a call to `hit` on the sandbox global named by
`PATTERN_COVERAGE_GLOBAL` (`"__cfPatternCoverage"`,
`src/core/transformers.ts`), passing the (possibly remapped) file name and
span id. The callee is an optional-chain property access, so the printed form
is parenthesized (asserted in `test/pattern-coverage-transformer.test.ts`):

```ts
// Shown for illustration only.
// Inserted before the instrumented statement.
(globalThis.__cfPatternCoverage?.hit)("mapped:/pattern.tsx", 1001);
```

Note the parenthesization: the `?.` guards only the property *read*; if the
global were absent, the statement would throw `TypeError`, not no-op. This
does not arise in practice because instrumented output exists only in
coverage compiles, and the runner installs the global for every evaluation of
a coverage-compiled graph (§16.7).

The registered span carries `{ fileName, id, kind: "runtime", startLine,
endLine, startColumn, endColumn }`; the transformer test "maps every
registered span" pins the exact shape, e.g. `const first = 1;` on authored
line 1 registers (after that test's +10/+100 `mapSpan`):

```ts
// Shown for illustration only.
{ fileName: "mapped:/pattern.tsx", id: 11, kind: "runtime",
  startLine: 101, endLine: 101, startColumn: 1, endColumn: 16 }
```

### 16.4 Why stage 25 (ordering)

Coverage runs second-to-last: after every lowering, schema, and module-scope
rewriting stage, so counters attach to the final shape of authored bodies
(closure-lowered callbacks included — pinned end-to-end by "pattern coverage
records callback body lines after the full pipeline" in
`packages/runner/test/pattern-coverage.test.ts`), with the original-node
fallback of §16.2 recovering authored positions for rebuilt statements. It
runs **before** `ModuleScopeFunctionHardeningTransformer` (stage 26) for the
reason stated on the stage spec itself (`src/cf-pipeline.ts`): "Coverage runs
before function hardening. That keeps coverage counters out of the hardening
helper output." — i.e. the synthetic hardening helpers emitted by stage 26
never acquire counters, so coverage reports only authored code. The stage
list itself is pinned by `test/pipeline-regressions.test.ts`.

### 16.5 Coupling: the one-line helper prelude and `lineOffset: -1`

The transformer computes span lines against the file it sees — which, for
every transformed module, is the helper-injected source of §2.1, not the
authored bytes. `injectCfHelpers` (`src/core/cf-helpers.ts`) builds
`[HELPERS_STMT, source, usedStmt].join("\n")`: exactly **one** line (the
`__cfHelpers` import) is prepended, and the trailer (the forwarding `h(...)`
helper, named `__cfHelpersShim` for modules binding `h` — §2.1) is
appended after the source. The runner compensates in its `mapSpan`
(`patternCoverageOptionsForCompile`, `packages/runner/src/harness/engine.ts`):

- every span is shifted by `lineOffset: -1`, the single prepended line — or by
  `0` for the two shapes that reach the compiler unchanged: a stored legacy
  envelope whose bytes already carry the helper import, and a file with no
  content line to inject ahead of;
- spans falling outside `[1, authoredLineCount]` after the shift are vetoed
  (`mapSpan` returns `undefined`), which drops counters from injected helper
  code: the prepended import could never span (imports are excluded, §16.2),
  but the appended `h` function's body would — the range check removes it,
  and the veto also suppresses the hit statement itself.

This is a deliberate two-sided contract, documented at both ends: the
`HELPERS_STMT` comment in `src/core/cf-helpers.ts` ("Runner pattern coverage
line remapping treats this helper import as a one-line prelude. Changes to
its line count need a matching update in patternCoverageOptionsForCompile.")
and the mirror comment on `patternCoverageOptionsForCompile`. Changing the
prelude's line count without updating the offset shifts every reported line.
Regression tests: "pattern coverage records original runtime lines", "…keeps
authored lines for mixed default and named imports", and "…keeps authored
lines when Common Fabric transform is disabled"
(`packages/runner/test/pattern-coverage.test.ts`).

File names are remapped alongside lines: the engine's `fileName` callback
(`coverageFilenameFor`) strips the whole-program `/<id>` prefix via
`storedFilenameFor`, while fabric-mount paths keep their
`/~cf/<identity>/...` form as the module-identity key; the collector's report
later normalizes mount paths to `cf-mount/...`
(`packages/runner/src/pattern-coverage.ts`).

### 16.6 Coupling: the compile byte cache is bypassed

In `compileToRecordGraph` (`packages/runner/src/harness/engine.ts`), the
cached-body lookup is short-circuited whenever coverage is on:

```ts
// Shown for illustration only.
// Coverage compiles need fresh emitted JavaScript because cached bodies do
// not include counters.
const cached = patternCoverage !== undefined
  ? undefined
  : options.precompiledModules ?? /* lazy precompiledModulesFor(...) */;
```

Both cache channels (`precompiledModules` and the lazy
`precompiledModulesFor`) are ignored, forcing a full TypeScript compile
through the transformer pipeline even when every module would otherwise be a
cache hit — a coverage run must produce instrumented bodies. The invariant
the comment relies on ("cached bodies do not include counters") holds on the
write side too: `compileToRecordGraph` still builds cache write-back
descriptors from the (instrumented) emitted JS, but the coverage entry point
`compileAndEvaluateModules` discards them — cache write-back is a separate
`PatternManager` step not used by `cf test` — so instrumented bodies do not
enter the cache. Regression test: "ignores precompiled bodies when pattern
coverage is enabled" (`packages/runner/test/esm-engine.test.ts`), which seeds
a poisoned full-hit cache and asserts a coverage compile recompiles and
counts lines.

### 16.7 Runtime consumption and LCOV

The consumer is `PatternCoverageCollector`
(`packages/runner/src/pattern-coverage.ts`): `registerSpan` records spans at
compile time; `hit(fileName, id)` increments a per-span counter at run time.
The engine remembers the collector per compiled graph
(`patternCoverageByGraph` WeakMap) and, on evaluation, installs
`collector.sandboxGlobal()` — an object exposing only `hit` — as
`globalThis.__cfPatternCoverage` in the module compartment's globals
(`packages/runner/src/harness/engine.ts`). Because spans are registered at
compile time and counted at run time, a compiled-but-never-executed statement
reports as an explicit zero-hit line rather than being absent.

`collector.report()` groups spans by normalized path (excluding `*.test.*`
files unless `includeTestFiles` is set) and resolves per-line hits with a
narrowest-span-wins rule plus a boundary-line maximum
(`hitsByRuntimeLine`): the narrowest span covering a line decides its count —
so an outer multi-line statement span cannot mark an unexecuted nested
callback body as covered — while a span's own start/end lines count as hit
when the span is hit, so compact one-liners like `if (flag) value = 1;`
record correctly (runner tests "…does not let outer spans cover unrun
callback bodies" and "…treats compact control flow as line coverage"). Only
`kind: "runtime"` spans participate.

`writePatternCoverageLcov` / `patternCoverageReportToLcov` emit standard LCOV
(`TN:pattern-runtime`, `SF`, per-line `DA`, `LF`/`LH`), with `DA` lines in
**authored** coordinates thanks to §16.5 — from "pattern coverage records
original runtime lines" (`packages/runner/test/pattern-coverage.test.ts`),
where `main.choose(1)` skips the authored `return 0;` on line 6:

```
TN:pattern-runtime
SF:/main.tsx
DA:2,1
DA:3,1
DA:4,1
DA:5,1
DA:6,0
LF:5
LH:4
end_of_record
```

`cf test` writes one
`<url-encoded relative test path>[--<participant>].pattern-coverage.lcov`
file per test into the coverage directory (`patternCoverageOutputPath`;
`packages/cli/lib/test-runner.ts`). Per `docs/development/COVERAGE.md`, those
files feed the CI coverage-debt gate as the sole source of covered-line data
for authored pattern files (currently only the `pattern-unit-test` job), and
`DA` records exist only for lines the instrumentation could name — the
denominator caveat documented there.

Test inventory for this stage: transformer unit suite
`test/pattern-coverage-transformer.test.ts`; end-to-end line mapping and LCOV
`packages/runner/test/pattern-coverage.test.ts`; cache bypass
`packages/runner/test/esm-engine.test.ts`; flag/env-var enablement
`packages/cli/test/test-runner-pattern-coverage.test.ts`; stage order
`test/pipeline-regressions.test.ts`. The `*.input.*`/`*.expected.*` fixture
corpus (§20) never enables the option, so fixture expectations contain no
counters.


## 17. Module-Scope Function Hardening And Verified-Binding Annotation

`ModuleScopeFunctionHardeningTransformer` (stage 26, **last**) rewrites a
module's top level so that every surviving module-scope function value is
frozen at module-evaluation time, and so that CFC trusted bindings carry a
machine-readable binding identity. It emits up to two module-local helper
function declarations and wraps or annotates top-level bindings with calls to
them (`src/transformers/module-scope-function-hardening.ts`). It extends the
base `Transformer` with no `filter` override, so it runs on every source file
the pipeline processes (`src/core/transformers.ts`). Both helpers' names and
the metadata field are imported from the cross-package sandbox contract:
`FUNCTION_HARDENING_HELPER_NAME = "__cfHardenFn"`,
`BINDING_IDENTITY_HELPER_NAME = "__cfBindVerifiedBinding"`,
`VERIFIED_BINDING_METADATA_FIELD = "__cfVerifiedBindingIdentity"`
(`packages/utils/src/sandbox-contract.ts`). The stage landed with the switch
to SES as the default runner sandbox (#3168); the verified-binding annotation
is CT-1665.

This is the one stage whose output is not merely consumed by the runtime but
**pattern-matched byte-for-byte by the runtime's security verifier** — see
§17.6.

### 17.1 Purpose: SES load-time freezing

The SES sandboxing model treats module-scope bindings as the main cross-
invocation communication channel to close: each callback invocation must be
isolated from shared mutable module state except through trusted Common
Fabric abstractions, and "closure-based data leakage" is mitigated by
"direct-function-only top-level forms plus function hardening"
(`docs/specs/sandboxing/SES_SANDBOXING_SPEC.md`, Key Principles and §11.1
threat table). Direct top-level functions are the one top-level category the
verifier admits without a data wrapper, and they must be "hardened
immediately after definition" (same spec, §4.2.2).

The emitted `__cfHardenFn` helper implements exactly that freeze:

```ts
function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
```

(AST-built in `createFunctionHardeningHelper`; the transformer emits a typed
`fn: Function` parameter, which TS emit strips back to the canonical untyped
form.) Semantics: freeze the function object itself (no property adds/writes,
no `fn.foo = …` side channel) and, when the function has an object-valued
`.prototype` (function expressions/declarations do; arrow functions do not),
freeze that prototype one level deep. This is a shallow `Object.freeze`, not
SES `harden()` — no transitive freezing of reachable values.

Per the SES spec's "Compiler Assists, Runner Enforces" principle, this
emission is canonical-form normalization, not the trust boundary itself:
"compiler output is not trusted and the runner must verify the final code
boundary" (`SES_SANDBOXING_SPEC.md`, Key Principles item 6, and its Phase 1
workstream "normalize direct top-level functions into canonical forms such as
`__cfHardenFn(function ...)`"). The runner independently re-freezes with the
same semantics elsewhere: `hardenVerifiedFunction`
(`packages/runner/src/sandbox/function-hardening.ts`) is applied to builder
implementations and registered verified functions
(`packages/runner/src/builder/{module,pattern}.ts`,
`src/harness/executable-registry.ts`), and the ESM record loader additionally
SES-`harden()`s every exported value
(`packages/runner/src/sandbox/module-record-compiler.ts`,
`hardenExportedValue`).

### 17.2 What gets hardened

The transformer visits only the source file's **top-level statements**
(`transformTopLevelStatement`); nested functions, class members, and
expression-level function values elsewhere are untouched. "Direct function"
below means an arrow function or function expression after
`unwrapExpression` — i.e. seen through parentheses, `as`, angle-bracket
assertions, `satisfies`, and non-null `!` wrappers
(`isDirectFunctionExpression`; `src/utils/expression.ts`).

Four shapes are rewritten:

1. **Named function declarations** (including `export function f` and
   `export default function f`): the declaration is kept and an expression
   statement `__cfHardenFn(f);` is appended immediately after it
   (`transformFunctionDeclaration`). Bodiless declarations — overload
   signatures, ambient declares — are skipped; for an overloaded function
   only the implementation declaration gets the trailing hardening statement
   (verified by direct pipeline run). Guarded by
   `test/transform.test.ts` "hardens direct top-level functions with a
   canonical helper" (`__cfHardenFn(next);`).

2. **Anonymous `export default function` declarations**: wrapped in place,
   the same shape as item 4 — `export default __cfHardenFn(function …);` —
   retaining `async` (`retainRuntimeFunctionModifiers` keeps only the
   `AsyncKeyword`) and the generator asterisk; no synthetic binding is
   minted. (An earlier shape minted a `const` via
   `factory.createUniqueName("__cfDefaultFn")` but re-created the export
   identifier from its bare `.text` — the §11.3 trap — so the emitted pair
   diverged and the module threw a load-time `ReferenceError`; the in-place
   rewrite removed the name pair entirely.) Guarded by
   `test/module-scope-function-hardening-coverage.test.ts` "anonymous
   default-exported function declaration is hardened in place on the export
   assignment" and "anonymous default-exported async function keeps its
   async modifier through the in-place rewrite".

3. **Variable statements** whose declarations have an identifier name and a
   direct-function initializer: the initializer is wrapped in place —
   `const step = __cfHardenFn((value: number) => value + 1);`
   (`transformVariableStatement`; asserted verbatim in
   `test/transform.test.ts`). Declarations with destructuring names or
   without initializers are left alone. The declaration keyword is **not**
   checked: top-level `let f = …`/`var g = …` direct functions are wrapped
   too (verified by direct pipeline run); the runtime verifier rejects
   non-`const` top-level bindings regardless ("Top-level mutable bindings are
   not allowed in SES mode", `compiled-bundle-verifier.ts`
   `verifyVariableStatement`). When detection unwrapped a type wrapper, the
   **original** wrapped expression is what gets hardened
   (`const wrapped = __cfHardenFn(((x: number) => x + 1) as unknown);`,
   verified by direct pipeline run); TS emit erases the type wrapper before
   the verifier sees it.

4. **Export assignments** (`export default <expr>`) whose expression is a
   direct function: wrapped in place,
   `export default __cfHardenFn((x: number) => x + 1);` (verified by direct
   pipeline run).

Everything else at top level is exempt: builder-call initializers
(`const h = handler(…)` — the builder layer hardens implementations at
runtime instead, `packages/runner/src/builder/module.ts`), `__cf_data`
wrappers and other call results, literals, classes, interfaces/type aliases
(erased at emit), `export default pattern(…)` (a call, not a direct
function), and the stage-19 hoisted `const __cfLift_N = __cfHelpers.lift(…)`
consts (call initializers; see the negative assertions in
`test/closures/module-scope-helper-hoisting.test.ts`).

Helper emission is demand-driven: each helper declaration is prepended (in
order: binding-identity helper, then hardening helper) **before every other
statement of the file, including imports**, and only when at least one use
was emitted (`transform`, the `updateSourceFile` construction). In practice
the hardening helper appears in essentially every transformed module, because
the default-on pre-transform (§2.1) injects a forwarding
`function h(…) { return __cfHelpers.h.apply(null, args); }` declaration
(named `__cfHelpersShim` when the module binds `h` itself, §2.1), which
shape 1 then hardens: as of this writing the trailing `__cfHardenFn(h);`
closes 381 of the 383 `*.expected.*` fixture files. The two exceptions are
the orphaned, input-less `closures/map-type-assertion.expected.jsx`, which
predates this stage, and `ast-transform/top-level-h-binding.expected.jsx`,
which closes with `__cfHardenFn(__cfHelpersShim);` instead.
Helper names are `createUniqueName`-minted, so they print as bare
`__cfHardenFn`/`__cfBindVerifiedBinding` unless the printer must
disambiguate — and a suffixed name would no longer verify (§17.6).

### 17.3 Verified-binding annotation (CT-1665)

The same stage stamps CFC **trusted bindings** with their authoring identity,
so a `WriteAuthorizedBy` claim embedded in a schema can later be matched to
the live handler that performs the write.

**Which bindings are trusted.** `collectWriteAuthorizedByBindingNames` scans
the stage-23 AST for type references to `WriteAuthorizedBy`,
`TrustedActionWrite`, or `TrustedActionWriteWithIntegrity` (binding position
= type argument 1 for all three, seeded in
`discoverWriteAuthorizedByBindingPositions`), plus any local type aliases
that forward a type parameter into such a position (computed to a fixed
point, so alias-of-alias works — `collectAliasBindingPositions`; exercised by
`test/cfc-authoring.test.ts` "lowers alias-referenced trusted builder
bindings"). Within each binding-position type argument, every `typeof x`
type-query identifier contributes `x` to the trusted-name set
(`collectTypeQueryIdentifiers`). Detection is purely name-based (no
symbol/import resolution), and it sees only type references **still present
after stages 15–17**: a reference that lived solely inside a
`toSchema<WriteAuthorizedBy<…>>()` type argument was already replaced by the
schema literal in stage 18 and contributes nothing (verified by direct
pipeline run — such a module gets a plain `__cfHardenFn` wrap and no
annotation), whereas references surviving in `interface`/type-alias
declarations or un-lowered type arguments do.

**What is emitted.** For a trusted binding whose initializer is a call
expression or a direct function (`isTrustedCallable`), the transformer emits
`__cfBindVerifiedBinding(value, metadata)` where metadata is

```ts
// Shown for illustration only.
{
    sourceFile: "/test.tsx",       // normalizeWriterIdentityFile(fileName)
    bindingPath: ["saveTitle"]     // single-element: the binding name
}
```

(`annotateBindingIdentifier` / `createBindingIdentityMetadata`). Placement
depends on export-ness (`transformVariableStatement`, guarded by
`test/cfc-authoring.test.ts`):

- **Exported** trusted binding — annotated **inline**, and when the
  initializer is a direct function the hardener nests outermost:
  `export const writeFn = __cfHardenFn(__cfBindVerifiedBinding((value:
  string) => value, {…}));` (verified by direct pipeline run; builder-call
  case asserted in "lowers exported trusted builder bindings inline").
- **Non-exported** trusted binding — declaration left untouched, followed by
  a statement-form annotation `__cfBindVerifiedBinding(saveTitle, {…});`,
  and, for direct-function initializers, a statement-form
  `__cfHardenFn(writeFn);` **after** the annotation. Named function
  declarations that are trusted get the same post-statement pair
  (declaration, annotation, hardening — verified by direct pipeline run).

The annotation-before-hardening order is load-bearing: the emitted binding
helper only stamps `Object.isExtensible` values
(`createExtensibleObjectOrFunctionCheck`), and hardening freezes the
function, so the reverse order would silently drop the identity.

The emitted `__cfBindVerifiedBinding` helper defines
`__cfVerifiedBindingIdentity` (`{ value: metadata, configurable: true }`) on
the annotated value itself and, when the value carries a function-valued
`.implementation` (builder factories do), on that implementation function too
(`createBindingIdentityHelper` / `createDefineBindingMetadataCall`).

**File normalization and mint-time stamps.**
`normalizeWriterIdentityFile` (`src/utils/writer-identity-file.ts`) normalizes
backslashes → slashes and then applies the caller-supplied
`canonicalWriterIdentityFile` option (`TransformerOptions`), the compile-name →
authored-name unmapping. `src/transformers/schema-generator.ts` uses it while
emitting `ifc: { writeAuthorizedBy: { __ctWriterIdentityOf: { file, path } } }`.
General nested/interface/alias claims are constructed by the schema-generator's
`CommonFabricFormatter`; the transformer passes it the same writer-source
resolver used by the direct-root special case. When
`TransformerOptions.moduleIdentities` contains the binding's defining compile
source, the payload also carries that source's `moduleIdentity`. The engine's
map covers its authored sources and is computed from pristine source before
the TS compile, so engine-minted claims are *born stamped* and the capturable
unstamped state is never minted (labs#4772 residual —
`writerIdentityForSourceFile` / `extractWriteAuthorizedByIdentity`). Supplying
an identity map that lacks the binding's defining source fails compilation;
only callers that omit the map entirely retain unstamped compatibility output.

The runner's engine passes its `storedFilenameFor`
(stripping the per-load `/${id}` module-path prefix and unmapping fabric-mount
paths — see the per-load-prefix normalization discussion in
`docs/specs/module-loading.md` §"Loader: per-module records in SES
compartments"), keeping claim and
provenance spellings load-independent and equal. Without the option the name
is recorded verbatim: direct compiles (HTTP resolver, piece manifests) already
present authored paths. Historical behavior — blindly stripping the first
segment of any absolute multi-segment name as a presumed engine prefix —
mis-spelled modules from direct compiles whose first segment was a real path
segment, shearing claims from provenance across compile stacks (labs#4772 /
CT-1886); stores hold claims minted under those spellings (see the
spelling-compat note in the normalizer's doc comment).

**Runtime consumption.** After a verified evaluation,
`Engine.#recordModuleProvenance` reads the annotation off each exported or
`__cfReg`-registered builder artifact (`readBindingIdentity`,
`packages/runner/src/harness/verified-provenance.ts`) and records it as
`VerifiedProvenance.bindingIdentity` against the implementation function.
CFC's implementation identity surfaces it as `sourceFile`/`bindingPath`
(`packages/runner/src/cfc/implementation-identity.ts`), and at commit the
`writeAuthorizedBy` check requires the writing identity's
moduleIdentity to equal the claim's directly or name an authenticated
`piece setsrc` predecessor, plus an equal binding path — the file SPELLING is
deliberately not load-bearing at verification (it is resolver-dependent;
labs#4772). Stamp MINTING (`rebindWriteAuthorizedByClaims`) still requires
exact slash-normalized file equality, and stored-claim reconciliation
tolerates spellings one leading segment apart
(`packages/runner/src/cfc/writer-claim-correspondence.ts`); when both sides
of a reconcile carry stamps for the same binding, the STORED stamp always
wins — a republished module's born-stamped claim never rotates the stored
one at merge time (its field writes are authorized at verification by
authenticated `piece setsrc` module delegation, or fail closed loudly
without one), and the envelope's sibling writes keep committing. The
non-exported case reaches provenance through the `__cfReg` registration sink
— the gap guarded by
`packages/runner/test/cfc-nonexported-binding-identity.test.ts`.

> **TODO (review after 2026-09-15): retire the pre-`moduleIdentity` aged-data
> exceptions.** The writeAuthorizedBy path carries several compatibility
> allowances purely so integrity works over data written before claims were
> `moduleIdentity`-anchored: the one-leading-segment spelling tolerance in
> reconciliation (`writerClaimFilesCorrespond`), stamp adoption onto stored
> *unstamped* claims, the legacy `bundleId` stamp arm, and the unstamped
> minting path for callers that omit the identity map. Claims born stamped
> (labs#4871) mean every write now anchors on `moduleIdentity`, so aged
> claims **self-heal on their next write** — once no pre-anchoring data
> remains, these exceptions can be deleted and verification tightened to
> require an exact `moduleIdentity` match. Revisit around mid-September 2026:
> confirm the aged-data population has drained (or force a rewrite sweep),
> then remove the tolerance in `writer-claim-correspondence.ts`, the
> unstamped-adoption branch in `reconcileWriterClaimStamp`, the `bundleId`
> arm, and this note. (Berni's ask on the labs#4871 review.)

No fixture in `test/fixtures/**` exercises `__cfBindVerifiedBinding` as of
this writing; the annotation paths are covered by `test/cfc-authoring.test.ts`
and the runner tests above.

### 17.4 Before/after example

Input (the `test/transform.test.ts` hardening case):

```ts
const step = (value: number) => value + 1;

export default function next(value: number) {
  return step(value);
}
```

Output (module scope; imports, shadow guards, and the injected `h` forwarder
shown in context — this matches `handler-schema/*.expected.jsx` shape):

```ts
function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const step = __cfHardenFn((value: number) => value + 1);
export default function next(value: number) {
    return step(value);
}
__cfHardenFn(next);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
```

And the trusted-binding statement form (non-exported handler; pinned by
`test/cfc-authoring.test.ts`, statement-form identity-annotation case):

```ts
// Shown for illustration only.
const saveTitle = handler(/* …injected schemas… */, (_event, { title, savedTitle }) => {
    savedTitle.set(title.get());
});
__cfBindVerifiedBinding(saveTitle, {
    sourceFile: "/test.tsx",
    bindingPath: ["saveTitle"]
});
```

### 17.5 Why it runs last

The stage-26 slot (after everything, and specifically after
`PatternCoverageTransformer`) is behaviorally significant (C-002):

- **After coverage (stage 25):** "Coverage runs before function hardening.
  That keeps coverage counters out of the hardening helper output"
  (`src/cf-pipeline.ts` stage-list comment). Coverage inserts
  `globalThis.__cfPatternCoverage?.hit(…)` statements into function bodies
  (`src/transformers/pattern-coverage.ts`); a counter inside `__cfHardenFn`
  or `__cfBindVerifiedBinding` would break the verifier's byte-equality
  recognition of the canonical helper bodies (§17.6) and would count helper
  executions as pattern coverage. The verifier separately allows the
  coverage-hit statements themselves at module scope
  (`isPatternCoverageHitStatement`, `compiled-bundle-verifier.ts`).
- **After hoisting (stage 19) and schema generation (stage 20):** the
  module-scope surface it freezes/annotates is final — hoisted
  `__cfLift_N`/`__cfPattern_N` consts exist (and stay unwrapped, being call
  initializers), and trusted-name discovery sees the post-lowering AST
  (§17.3).
- **Nothing downstream re-analyzes wrapped functions.** Within one pipeline
  run no stage follows it; for analysis code that may encounter hardened
  output, call-kind resolution can see through `__cfHardenFn*(…)` wrappers
  via `unwrapHardenedCallbackExpression` (`src/ast/call-kind.ts`,
  `FUNCTION_HARDENING_HELPER_PREFIX`), and `cf view` classifies the helper
  names for display (`packages/cli/lib/view/languages/typescript/vocab.ts`).

### 17.6 The verifier contract (cross-package, normative)

The helper names **and the exact text of the helper bodies** are a published
compile-side/runtime-side contract, centralized in
`@commonfabric/utils/sandbox-contract`
(`packages/utils/src/sandbox-contract.ts`): the transformer imports the
names; the runner's module verifier imports the same names plus
`createFunctionHardeningHelperSource()` /
`createBindingIdentityHelperSource()` — string builders whose output must be
what the transformer's AST-built helpers compile to. Changing what this stage
emits is therefore a cross-package contract change — module loading breaks
until the verifier agrees (also stated in
`packages/ts-transformers/AGENTS.md`, "Local facts"). The verifier
(`packages/runner/src/sandbox/compiled-bundle-verifier.ts`) enforces:

- **Canonical-declaration recognition by byte equality.** Every top-level
  function declaration is registered with
  `hardeningHelper`/`bindingIdentityHelper` flags set only if its
  trivia-stripped statement text equals the trivia-stripped canonical source
  (`CANONICAL_HARDENING_HELPER`, `isFunctionHardeningHelperDeclaration`,
  `registerFunctionStatement`). The module-loading spec states the rule
  directly: "canonical function-hardening (`__cfHardenFn(fn)`) and
  binding-identity statements recognized by byte-equality to
  `sandbox-contract.ts` sources"
  (`docs/specs/module-loading.md` §"Security classification"). A same-named
  helper with a different body is just an ordinary function — and the module
  then fails on its call sites: pinned by the adversarial case "fake
  (non-canonical) __cfHardenFn laundering a callback"
  (`packages/runner/test/esm-verifier-adversarial.test.ts`).
- **Statement grammar.** An expression statement is admitted as hardening
  only if it normalizes to `ident(ident);` where the callee binding has
  `hardeningHelper === true` and the target binding classified as a
  **function** (`isAllowedFunctionHardeningStatementNormalized`) — so
  builders can't be statement-hardened, matching what the transformer emits.
  A binding-identity statement must normalize to `ident(ident, {…});` with
  the callee either literally named `__cfBindVerifiedBinding` or classified
  as the canonical helper, and the target classified function-or-builder
  (`isAllowedBindingIdentityStatementNormalized`).
- **Expression grammar.** In initializer/argument position,
  `__cfHardenFn(x)` must have **exactly one** argument ("Function hardening
  helpers accept exactly one argument") and `x` must classify as a direct
  function ("Function hardening must target direct function values"); the
  result classifies as that function, so
  `__cfHardenFn(__cfBindVerifiedBinding(fn, {…}))` nests. The binding helper
  takes exactly two arguments ("Verified binding annotation helpers accept
  exactly two arguments") and classifies as its first argument, which must
  not be `unknown` ("Verified binding annotation must target trusted
  top-level bindings" — pinned by the adversarial "builder callback is
  non-function data via binding-identity helper" case). Any other top-level
  call is rejected: "Only trusted builder calls, schema(), canonical
  function hardening, and canonical binding annotation are allowed at module
  scope in SES mode" (asserted in
  `packages/runner/test/compiled-module-verifier.test.ts`, which also pins
  acceptance of the exact canonical compiled form in "accepts canonical
  compiled function hardening").
- **The helper is not a callback.** A trusted-builder callback referenced by
  name must resolve to a plain function binding, explicitly excluding
  `hardeningHelper` bindings (`resolveTrustedBuilderCallback`).
- **Where it runs.** `verifyCompiledModuleBody` runs this classification once
  per module body, over the shared `classifyModuleItems` core with empty guard
  sets (`packages/runner/src/sandbox/module-record-verifier.ts`;
  `ModuleItemClassificationOptions` doc comment). That is on the compile path,
  and again on the warm cached-closure load path unless the bodies arrived
  through an integrity-gated read (`trustedBodies`). There is one emit, so the
  canonical helper sources have one byte form to match.

Consequence for maintenance: the transformer's AST helper builders
(`createFunctionHardeningHelper`, `createBindingIdentityHelper`) and the
sandbox-contract string builders are maintained **by hand in two encodings**.
Any drift between them is loud — every transformed module carries at least
`__cfHardenFn(h);` (§17.2), so a non-matching helper fails verification for
every pattern load — and the equivalence is asserted directly by
`packages/runner/test/sandbox-contract-helper-equivalence.test.ts`, which
transforms a module and compares each emitted helper declaration's
trivia-stripped text against the corresponding string builder's output
(`packages/utils/test/sandbox-contract.test.ts` covers only the trusted-name
lists).

### 17.7 Edge cases (observed)

- Overloaded functions: signatures untouched, one `__cfHardenFn(f);` after
  the implementation (direct pipeline run).
- `let`/`var` direct functions: wrapped by the transformer, then rejected by
  the verifier as mutable top-level bindings (direct pipeline run;
  `verifyVariableStatement`).
- Anonymous `export default function`: a single in-place
  `export default __cfHardenFn(function …);` statement, no synthetic binding
  (§17.2 item 2). The declaration's hoisted-binding semantics are not
  preserved — initialization moves to the statement's evaluation position,
  observable only under circular imports (the pre-fix const shape lost
  hoisting identically).
- `async` is preserved on the anonymous-default rewrite; all other modifiers
  (`export`, `default`) are dropped from the synthesized function expression
  (`retainRuntimeFunctionModifiers`). Generator asterisks pass through
  unchanged; top-level generator declarations are rejected later by the
  verifier regardless (`module-loading-verifier-and-engine-design.md`,
  security-classification list).
- Trusted names referenced **only** via `toSchema<…>()` type arguments get a
  schema-side claim but no binding annotation, because stage 18 erased the
  reference before stage 26 ran (direct pipeline run; compare
  `test/cfc-authoring.test.ts` "preserves the local binding identity through
  schema emission", which asserts only `__ctWriterIdentityOf`).
- A trusted binding whose initializer is neither a call nor a direct
  function (e.g. a literal) is skipped entirely — trusted-ness alone does
  not annotate (`transformVariableStatement` gate on `isTrustedCallable ||
  isDirectFunction`). Malformed `WriteAuthorizedBy` usage was already
  diagnosed at stage 16 (§6.8).
- The hardening wrapper preserves evaluation semantics (`return fn`), so
  wrapped initializers remain direct-function-classifiable to the verifier,
  while debug `fn.src` is resolved independently through the compiler sidecar
  (§11.6).


## 18. Diagnostics Message Transformation (Optional Consumer Layer)

Diagnostic message transformation is exported separately from AST transform
pipeline. A diagnostic message transform is a plain function taking a
TypeScript diagnostic message and returning either a replacement message or
null when it does not apply. Current built-in behavior:

- `createReactiveErrorTransformer` builds a transform that rewrites TypeScript
  messages matching
  `"Property 'get' does not exist on type 'OpaqueCell<...>'"` into user-facing
  guidance about unnecessary `.get()`.
- its optional `verbose` argument appends the original TypeScript message.

## 19. Current Known Limits (Observed)

1. Generic helper functions with uninstantiated type-parameter lift-applied
   result types can degrade schema precision (type arguments may be
   intentionally omitted).
2. Action and JSX inline handler callback extraction currently unwraps arrow
   functions only.
3. Non-static destructuring defaults, rest destructuring, and unsupported
   computed destructuring keys in pattern callbacks remain non-lowerable and
   produce pattern-context diagnostics.
4. Interprocedural capability propagation applies only when a resolved callee
   declaration is analyzable in-proc (arrow/function
   expression/declaration/method); external/unresolved calls remain
   conservative.
5. The CFC authoring contract under `docs/specs/ts-transformer/cfc_*.md` is
   implemented for the canonical alias set: the schema-generator's
   common-fabric formatter lowers `Cfc` payloads, the wrapper aliases, the
   projection helpers, and the `WriteAuthorizedBy` writer-identity marker into
   `ifc.*` schema metadata during the `SchemaGeneratorTransformer` stage. The
   former collection/opaque helpers were removed (the runner rejects their
   lowered keys fail-closed). `WriteAuthorizedBy` usage is additionally
   validated (`cfc-write-authorized-by`, §6.8). Static policy declarations and
   `PolicyOf` bindings are additionally validated by their dedicated passes;
   schema generation resolves the resulting exact manifest marker. The
   `WriteAuthorizedBy` validation remains a separate transformer rather than a
   schema-generator responsibility.
6. Invoking a function value that flows through reactive pattern data (for
   example a function-typed input property called as `input.fn(...)` or
   `input.fn?.(...)`) produces no diagnostic at any expression site. Function
   values are not schema-representable, so synthesized lift input schemas
   silently drop function-typed captures; the lowered closure then reads an
   absent property at runtime, making the call dead code (`undefined` under
   optional invocation, a runtime `TypeError` when a plain invocation is
   reached). The target language classifies such callable roots as
   unsupported — the problem is the unstorable function value, not the call
   syntax — but that classification is not yet surfaced as an authoring-time
   diagnostic. The open follow-up is recorded in the design-deltas addendum.

## 20. Test Coverage Snapshot

The fixture suites driven by `fixture-based.test.ts` live under
`test/fixtures/<suite>/` as `*.input.*` / `*.expected.*` pairs. The driver
currently runs these suites:

- `ast-transform`
- `handler-schema`
- `jsx-expressions`
- `schema-transform`
- `closures` (the largest suite by a wide margin)
- `kitchensink`
- `schema-injection`

(The `bug-repro` directory exists but is not an input/expected fixture suite.)

Exact counts are intentionally not pinned here — they churn with every fixture
addition. The fixture corpus is in the high hundreds of input files overall, of
which `closures` is the largest single suite. To get current numbers:

```bash
# per suite
for d in test/fixtures/*/; do
  printf '%s: %s\n' "$(basename "$d")" "$(ls "$d"*.input.* 2>/dev/null | wc -l)"
done
# total input fixtures
find test/fixtures -name '*.input.*' | wc -l
```

The unit-test harnesses and assertion helpers themselves are documented in
`packages/ts-transformers/test/README.md` (#4498).

Additional non-fixture unit suites cover:

- cast/empty-array/pattern-context/opaque-get/schema-shrink validation
- diagnostic message transformer behavior
- event-handler detection heuristics
- reactive analysis and normalization APIs
- pipeline regression and policy/capability-analysis behavior
- lift-applied call helper and identifier utilities

## 21. Stability Statement

This specification is a snapshot of current behavior. Any transformer code or
fixture expectation changes should be treated as spec changes and reflected in
this document.

### 21.1 Keeping This Spec Current (Sources Of Truth)

Several facts in this document are enumerations the implementation already
centralizes. When they change, update the spec from the canonical source rather
than hand-maintaining a parallel list — and prefer pointing at the source over
re-listing it. The enforced sources of truth:

| Spec content | Canonical source | Guard / note |
| --- | --- | --- |
| Pipeline stage set + order (§3) | `CFC_TRANSFORMER_STAGES` / `CFC_TRANSFORMER_STAGE_NAMES` (`src/cf-pipeline.ts`) | the array literal is the order; the names are the class names |
| Cross-stage registries (§2.2) | `CrossStageState` (`src/core/cross-stage-state.ts`) | NodeLinks-shaped families |
| Recognized runtime exports + which are reactive origins (§5, §6.3) | `COMMONFABRIC_RUNTIME_EXPORT_REGISTRY` (`src/core/commonfabric-runtime-registry.ts`) | `test/core/commonfabric-runtime-registry.test.ts` asserts coverage of the runner builder factory |
| SES self-contained callback boundaries (§6.5) | `SES_SELF_CONTAINED_CALLBACK_BOUNDARIES` (`src/transformers/pattern-context-validation.ts`) | excludes `sqlite-row-label-rule` by design |
| Lowerable expression-site container kinds (§6.7) | `getExpressionContainerKind` (`expression-site-policy.ts`) | — |
| Reserved keys the framework puts on a pattern result (§6.12) | `FRAMEWORK_RESULT_KEYS` (`packages/utils/src/framework-result-keys.ts`) | imported by both readers rather than restated: this package cannot import the runner, which imports it, so the shared spelling sits below both and `packages/runner/src/builder/types.ts` re-exports it onto the builder surface |
| Diagnostic `type:` strings | the emitting transformer's `reportDiagnostic` calls | grep `type: "…"` per validator |
| Auto-`.for()` cause triggers, cause-path grammar, and the `__patternResult` root (§13) | `shouldAddReactiveFor` / `createForCall` / `PATTERN_RESULT_CAUSE` (`src/transformers/reactive-variable-for.ts`) | emitted shapes pinned by the stable-cause tests in `test/transform.test.ts` |
| Shadow-guard binding set + canonical guard text (§14) | `SHADOWED_FACTORY_BINDINGS` / `createFactoryShadowGuardSource()` (`packages/utils/src/sandbox-contract.ts`); insertion point `findFactoryGuardInsertionIndex` (`src/transformers/module-scope-shadowing.ts`) | emission byte-pinned by ~all fixture expected outputs; verifier consumes the same constants via `RESERVED_FACTORY_BINDINGS` (`packages/runner/src/sandbox/compiled-bundle-verifier.ts`); `cf view`'s `SCAFFOLDING_NAMES` (`packages/cli/lib/view/languages/typescript/vocab.ts`) is an unimported copy — check for drift |
| Module-scope `__cf_data` wrap/exclusion name sets + verifier error strings (§15) | `TRUSTED_BUILDERS` / `TRUSTED_DATA_HELPERS` (`packages/utils/src/sandbox-contract.ts`); `CF_DATA_CONSTRUCTOR_NAMES` (`src/transformers/module-scope-cf-data.ts`); `TOP_LEVEL_CALL_RESULT_ERROR` (`packages/runner/src/sandbox/policy.ts`) | one module feeds both transformer and runner verifier — cross-package contract; runtime freezer semantics live in `packages/runner/src/sandbox/plain-data.ts` |
| Coverage instrumentation + span schema (§16) | `PatternCoverageTransformer` (`src/transformers/pattern-coverage.ts`); `PatternCoverageSpan` / `PatternCoverageOptions` / `PATTERN_COVERAGE_GLOBAL` (`src/core/transformers.ts`) | line remapping pins the one-line helper prelude: `HELPERS_STMT` (`src/core/cf-helpers.ts`) ↔ `patternCoverageOptionsForCompile` (`packages/runner/src/harness/engine.ts`) — change them together |
| Hardening/binding helper names, metadata field, canonical helper bodies (§17) | `FUNCTION_HARDENING_HELPER_NAME` / `BINDING_IDENTITY_HELPER_NAME` / `VERIFIED_BINDING_METADATA_FIELD` and `createFunctionHardeningHelperSource` / `createBindingIdentityHelperSource` (`packages/utils/src/sandbox-contract.ts`) | the runner verifier recognizes helper declarations by trivia-stripped byte equality to these sources (`CANONICAL_HARDENING_HELPER` in `packages/runner/src/sandbox/compiled-bundle-verifier.ts`); the transformer's AST-built twins (`createFunctionHardeningHelper` / `createBindingIdentityHelper` in `src/transformers/module-scope-function-hardening.ts`) must compile to exactly that text — drift fails every module load |
| Trusted-binding type names + binding positions (§17.3) | seed map in `discoverWriteAuthorizedByBindingPositions` (`src/transformers/module-scope-function-hardening.ts`) | keep in sync with `WriteAuthorizedByValidationTransformer` (§6.8) and the schema generator's `__ctWriterIdentityOf` claim emission; both spell files via the shared `normalizeWriterIdentityFile` (`src/utils/writer-identity-file.ts`) so claim and provenance spellings cannot drift |

A drift-resistant habit: when a section enumerates a set, cite the constant /
function that defines it so a reader can confirm the live set, and keep prose
lists explicitly labeled "as of this writing."
