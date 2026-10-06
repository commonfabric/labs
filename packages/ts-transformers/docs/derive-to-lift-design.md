# `derive` → `lift` → `selfcontained`: design

<!-- The third phase's marker was called "sandboxable" in early drafts; the
final name is "selfcontained" (Berni, 2026-05-21). Some historical sections
below still read "sandboxable" as a concept word — they describe the same thing. -->

_Status: Phase 1 complete in CT-1615 (lift-applied form
`__cfHelpers.lift(cb)(input)`). Registry-architecture follow-up landed in PR
#3707 (registries consolidated into `CrossStageState`). No-input form switch
landed in PR #3709 (`computed`-origin lifts now emit `lift(false, fn)()` instead
of the `lift(...)({})` stopgap). **Phase 2 complete in CT-1644** (the
transformer then called `LiftHoistingTransformer` hoists every lift call to a
module-scope `const __cfLift_N = __cfHelpers.lift(...)`, after SchemaInjection;
subsumes lift from the CT-1585 callback hoister). `derive` has since been fully
retired from both the transformer (CT-1643) and the runtime export (CT-1624).
**CT-1655 extends Phase 2's whole-call hoisting to the other builders**:
`handler` (hoisted to `const __cfHandler_N`) and `pattern` (hoisted to
`const __cfPattern_N` out of `mapWithPattern` and `patternTool` argument
position) shipped; the old callback hoister was deleted and the sole stage is
now `BuilderCallHoistingTransformer`. The enclosing `patternTool(...)` call
itself stays in place because its per-instance captures live in its second
argument. **Phase 3 (`selfcontained` marker) remains unimplemented** — its
design below is the active proposal and its open questions are mostly resolved
(see the Phase 3 section and tracker). Historical phase notes retain the
transformer names that existed when those investigations ran; the glossary near
the end maps the current code._

## Motivation

After CT-1585 landed module-scope hoisting for builder callbacks, several
follow-up improvements emerged from review (especially from Berni). The shared
thread: we want every reactive computation in lowered output to be
**addressable** (you can point to its concrete source location) and, when
possible, **sandboxable** (the computation can be stringified and executed in a
transient sandbox without breaking).

The plan is three sequential phases. Each lands as its own PR after the prior
one is merged.

| Phase | What changes                                                                                                                                                                                          | Who benefits                                                                                                                                  |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Rewrite every `derive` call (user-authored + transformer-synthesized) into a `lift` call, in place.                                                                                                   | Establishes a single canonical builder for reactive lifted-function computations. Tooling no longer needs to special-case `derive` vs `lift`. |
| 2     | Hoist every `lift` call (the whole call, not just its callback) to module scope. The body becomes `__cfLift_N(closureInputObject)`.                                                                   | Every reactive computation is named and addressable. Sandboxing/serialization decisions can be made per-lift.                                 |
| 3     | Wrap each qualifying lift's arguments in `__cfHelpers.selfcontained(...)` _only on lifts that don't close over any user-authored module-scoped variables_ (and meet a few other gates — see Phase 3). | Runtime can safely move selfcontained lifts across sandbox boundaries.                                                                        |

After all three phases land for `lift`, the same pattern extends to `handler`
(which `action` lowers into) and to `pattern` (including transformer-synthesized
pattern callbacks for `mapWithPattern` and friends). These are tracked under
CT-1655, which converges the CT-1585 callback hoister and
`LiftHoistingTransformer` into one unified module-scope hoisting phase.

**Handler shipped in CT-1655.** `handler` is emitted in the same
single-application shape as lift —
`__cfHelpers.handler(eventSchema, stateSchema, cb)(captures)` (an `action` is
lowered to this `handler` shape upstream, so it gets the same treatment) — so
the hoist is mechanically identical to lift: the inner `handler(...)` call is
hoisted to `const __cfHandler_N = __cfHelpers.handler(...)` and the original
site becomes `__cfHandler_N(captures)`, with the `.for(...)` tail left anchored
on the outer call. Implementation notes:

- A new `HANDLER_BUILDER` `HoistableBuilderSpec` (prefix `__cfHandler`)
  registers in `lift-hoisting.ts`'s `HOISTABLE_BUILDERS` alongside
  `LIFT_BUILDER`.
- Recognition uses a dedicated `isHandlerAppliedCall` predicate (not the
  `lift-applied` CallKind): a handler-applied call keeps classifying as
  `{ kind: "builder", builderName: "handler" }`, so every handler-specific
  downstream dispatcher (ReactiveVariableFor's stream cause, capture-schema
  injection, write-authorization, etc.) is unaffected.
- `handler` is removed from CT-1585's `HOISTABLE_BUILDER_NAMES` in the same
  change to avoid the double-hoist TDZ (the two consts would reference each
  other out of declaration order).
- The hoist-prefix original-node fallback in `resolveBuilderExpressionKind` is
  generalized to `__cfHandler` so the synthetic `__cfHandler_N(captures)` site
  still classifies as `handler` for the stages that run after hoisting.

**Pattern shipped in CT-1655 (next).** `pattern`'s hoist is a _different_
mechanic: pattern is not applied — a reactive map lowers to
`expr.mapWithPattern(__cfHelpers.pattern(cb, inSchema, outSchema), { params })`,
so the bare `pattern(...)` call (argument 0 of `mapWithPattern`) is the
hoistable unit, with per-instance captures flowing through `mapWithPattern`'s
_second_ argument. The bare pattern call is therefore capture-free and safe to
evaluate once at module scope. Implementation notes:

- The hoisting stage was renamed `LiftHoistingTransformer` →
  `BuilderCallHoistingTransformer` (`lift-hoisting.ts` →
  `builder-call-hoisting.ts`): it now owns lift + handler + pattern, the
  "Call"-vs-"Callback" contrast distinguishing it from the
  `BuilderCallbackHoistingTransformer` it is subsuming.
- `HoistableBuilderSpec` gains an optional `rewriteSite` hook. Applied builders
  (lift/handler) keep the default callee-swap; pattern provides `rewriteSite` to
  replace just `mapWithPattern`'s first argument with the hoisted name, leaving
  the callee and the params argument intact.
- Recognition is positional via `getMapWithPatternHoistablePatternCall`: a
  `*WithPattern` call whose first argument is a `pattern(...)` builder call. The
  top-level `export default pattern(...)` is a _direct_ call (not a
  `*WithPattern` argument), so it is naturally excluded — no special guard
  needed.
- `pattern` is removed from CT-1585's `HOISTABLE_BUILDER_NAMES` in the same
  change (same double-hoist-TDZ rationale; observed directly without it).
- Pattern's hoisted reference sits in `mapWithPattern` argument position, not an
  applied reactive-origin site, so it does _not_ need the
  `resolveBuilderExpressionKind` original-node fallback (confirmed: full suite
  green without it).
- **Insertion ordering (eager-callback hazard).** `pattern(...)` _invokes_ its
  callback eagerly at construction (`runner/src/builder/pattern.ts`,
  `const outputs = fn(...)`) to capture the reactive graph — unlike `lift`/
  `handler`, whose callbacks are stored and run lazily. So a hoisted
  `const __cfPattern_N = pattern(cb)` placed naïvely after the imports throws a
  module-load TDZ `ReferenceError` if `cb` reads a module-scoped binding
  declared later (e.g. `const onRemoveFavorite = handler(...)` used inside a
  mapped JSX — see `patterns/system/favorites-manager.tsx`). The stage therefore
  no longer pools all hoists into one after-imports block; it flushes each
  statement's hoists immediately _before_ that top-level statement. That keeps
  every hoist after the module-scoped bindings its (eagerly-run) callback
  references, since the original use site necessarily followed those
  declarations. The transformer's golden tests only check emitted text, so this
  was caught by the runner's pattern-execution tests, not the fixture suite.

**`patternTool` resolution.** The canonical form is
`patternTool(pattern(fn), { extraParams })`. The enclosing call stays at its
authored site so per-instance `extraParams` stay local, while
`BuilderCallHoistingTransformer` hoists the inner `pattern(...)` argument. This
emptied the old CT-1585 callback-hoister set; that transformer and its
module-scope callback-analysis module were deleted.

## Relationship to prior work

- **CT-1585** added module-scope hoisting for builder callbacks whose body
  closed only over module-level symbols. At that point the hoister:
  - Lived in
    `packages/ts-transformers/src/closures/module-scope-callback-hoisting.ts`.
  - Ran as `BuilderCallbackHoistingTransformer`, scheduled immediately after
    `PatternCallbackLoweringTransformer` in `cf-pipeline.ts`.
  - Hoisted the **callback** (the function-like argument), not the call.
  - Was conditional on the callback's body genuinely closing over user-authored
    module-level references (post the over-trigger/under-trigger precision fixes
    in commits 4 and 5).
- Phase 2 **generalized** this: every `lift` gets hoisted, the call site reads
  `__cfLift_N(inputs)`, and the predicate that gates hoisting goes away. The
  mechanics from CT-1585 (counter-based naming, transformer-injected-identifier
  exclusion list, synthetic-compute-callback handling) carry forward.

## Phase 1: `derive` → `lift` in-place rewrite

### Goal

After Phase 1, **no `derive(...)` call exists anywhere in lowered output.**
Every reactive lift-style computation is a `lift(...)` call. This includes:

- User-authored `derive(input, callback)` and `derive<T, R>(input, callback)`
  calls.
- Transformer-synthesized `derive(input, callback)` calls produced by:
  - `createDeriveCall` in
    `packages/ts-transformers/src/transformers/builtins/derive.ts:186` (used to
    wrap JSX expressions whose return value involves opaque captures, and the
    `computed(...)` → `derive(...)` rewrite). (Post-Phase-1: renamed to
    `createLiftAppliedCall` in `src/transformers/builtins/lift-applied.ts`;
    emits the lift-applied form directly.)
  - Any other call site in the transformer that synthesizes
    `__cfHelpers.derive(...)` — these should be discoverable via grep for
    `createHelperCall(..., "derive", ...)` or similar.
- The Phase 1 implementer should also audit the `computed` builder. It is
  currently rewritten to `derive`; after Phase 1 it should rewrite to `lift`
  directly (or `computed` → `derive` → `lift` is fine as long as no `derive`
  survives).

### Constraints to verify

These are **assumed correct based on conversations with Berni** but the Phase 1
implementer must verify each empirically before relying on them:

1. **`lift` is a semantic synonym for `derive` at runtime.** Both should accept
   `(input, callback)` and produce a reactive value. Check the runtime to
   confirm — relevant entry points likely live in `packages/runner/src/`. If
   `lift` has _different_ semantics (e.g. different recomputation triggers,
   different argument shapes), the rewrite is not a simple rename and Phase 1
   must compensate (e.g. by wrapping or unwrapping the input).

2. **Captures already flow through the input-object argument.** The CT-1585 era
   closure transformer was supposed to rewrite user-authored derives so all
   captured values pass through the input object, not via lexical closure. If a
   user writes `derive(input, ({x}) => useOuterY(x))` where `Y` is
   enclosing-scope, the closure transformer should already have lifted `Y` into
   the input object. Verify this on representative fixtures. If there are
   residual cases where user-authored `derive` callbacks lexically capture
   without going through inputs, those cases need to be either (a) covered by
   Phase 1's rewrite to ensure they still work after `derive` → `lift`, or (b)
   flagged as a pre-existing bug and addressed separately.

### Implementation strategy

A new `DeriveToLiftRewriteTransformer` stage. The body of the change is small
(mostly a node visitor that rewrites builder names), but the placement in the
pipeline matters and should be determined empirically:

- **Likely placement: after `ClosureTransformer`, before
  `PatternOwnedExpressionSiteLoweringTransformer`.** The closure transformer is
  where most synthetic derives get introduced. Rewriting `derive` → `lift`
  immediately after closure means subsequent stages dispatch on `"lift"`
  uniformly.
- **But: many downstream stages still dispatch on `callKind?.kind === "derive"`
  (see `schema-injection.ts:2905`, `pattern-context-validation.ts:801`,
  `expression-rewrite/rewrite-helpers.ts:93`, `expression-site-policy.ts:404`,
  etc.).** Phase 1 must either:
  - **(a)** Place the rewrite _after_ every stage that dispatches on `derive`
    (in which case those stages all keep working unchanged). This is
    conservative but late in the pipeline.
  - **(b)** Place the rewrite earlier and update every stage to dispatch on
    `lift` (or accept both). This is more invasive but cleaner.

  The implementer should map all the derive-dispatching sites (grep
  `kind === "derive"` and `builderName === "derive"` in
  `packages/ts-transformers/src/`), then decide. Option (a) is the recommended
  starting point — get the rewrite working without churning all the dispatchers,
  then evaluate whether option (b) becomes clean later. **A single grep over the
  source after Phase 1 should find zero remaining `derive` references outside of
  CommonFabric runtime registry entries and Phase 1's own rewrite logic.**

### `callKind` infrastructure

`packages/ts-transformers/src/ast/call-kind.ts` is where `detectCallKind` lives
— the single source of truth for "what kind of call is this." After Phase 1, the
`callKind === "derive"` branch should probably be deleted (no more derives exist
post-Phase-1) and any helper functions named after `derive` should be renamed or
removed. The implementer should be careful: some helpers in this file may still
want to recognize _pre-Phase-1_ derive shapes (for backward compatibility with
external callers or for the transformer's own infrastructure). Audit each before
deleting.

### Tests

- **New fixture pair** that exercises a transformer-synthesized derive (e.g. a
  JSX expression in a map callback that captures an opaque value, so the closure
  transformer wraps the return in `derive(...)`). The `.expected.jsx` should
  contain `__cfHelpers.lift(...)` and zero `__cfHelpers.derive(...)` references.
- **Existing fixture goldens will largely change** — every fixture that
  currently shows `__cfHelpers.derive(...)` in its expected output will need its
  golden regenerated. Use `UPDATE_GOLDENS=1 deno task test` once the rewrite is
  wired up. Audit a sample of the regenerated goldens to confirm they look
  right.
- **Runtime tests must still pass.** Run
  `deno task cf test --root packages/patterns` against the failing-pattern
  repros from CT-1585 (`notes/note.test.tsx`, `notes/notebook.test.tsx`,
  `factory-outputs/parking-coordinator/main.test.tsx`) and a representative
  sample of others. If `lift` and `derive` are runtime synonyms, all should pass
  without modification.
- **Pipeline stage-order regression test** at
  `test/pipeline-regressions.test.ts:96` must be updated to include the new
  stage.

### Risks

- **`computed` rewriting**: there's an existing `ComputedTransformer` stage that
  rewrites `computed` to `derive`. After Phase 1, either that stage's output is
  rewritten to `lift` by Phase 1's pass, or `ComputedTransformer` itself starts
  emitting `lift` directly. The implementer should decide based on which keeps
  the diff small. (Post-Phase-1: the stage is renamed to
  `LiftLoweringTransformer` in `src/lift/transformer.ts` and lowers both
  `computed(...)` and user-source `derive(...)` directly to the lift-applied
  form.)
- **`derive` callbacks with explicit `<T, R>` type parameters**: user-authored
  `derive<T, R>(input, cb)` calls in source. The transformer probably reads
  those type params for schema inference at the `derive` call site. After
  rename, the type params come from the `lift<T, R>` runtime declaration — which
  should be identical, but verify.
- **Pipeline regression tests** that pin specific surface forms
  (`assertStringIncludes(output, "__cfHelpers.derive(...)`) will need to update.
  Search `test/pipeline-regressions.test.ts` and similar for hardcoded `derive`
  strings before starting.

### Out of scope for Phase 1

- Hoisting (that's Phase 2).
- Sandboxable marker (that's Phase 3).
- `handler`/`pattern` rewrites (mentioned in motivation; addressed by follow-up
  work after Phase 3).

## Phase 2: hoist every `lift` call to module scope (sketch)

After Phase 1: every reactive lift-style computation in lowered output is a
`lift(...)` call. Phase 2 hoists each one to module scope.

### Mechanic

For a call site like:

```ts
__cfHelpers.lift(
  { inputSchema },
  { outputSchema },
  captures,
  ({ x, y }) => x + y,
);
```

Phase 2 rewrites it to:

```ts
// At module scope:
const __cfLift_N = __cfHelpers.lift(
  { inputSchema },
  { outputSchema },
  ({ x, y }) => x + y,
);

// At call site:
__cfLift_N(captures);
```

Note three changes from the existing CT-1585 hoist:

1. **The entire `lift(...)` call** (schemas + callback) gets hoisted, not just
   the callback. The runtime treats the result of `__cfHelpers.lift(...)` as a
   _callable_ that takes the captures-object and returns the reactive cell. The
   call site applies the captures.
2. **No predicate.** Every lift gets hoisted, regardless of what its body closes
   over. The predicate logic from CT-1585 (`analyzeCallbackForHoisting`,
   `isTransformerInjectedIdentifier`, the ambient-globals exclusion) becomes
   Phase 3's input — it informs the _sandboxable_ decision, not the hoist
   decision.
3. **New naming prefix**: `__cfLift_N` instead of `__cfModuleCallback_N`. The
   CT-1585 prefix was generic because it covered derive/handler/lift/pattern
   callbacks; now we have a builder-specific hoist and can use a
   builder-specific prefix.

### Open questions for Phase 2 — RESOLVED (CT-1644)

- **Where in the pipeline?** **After `SchemaInjectionTransformer`, before
  SchemaGenerator. Verified empirically 2026-06-02.** A spike initially
  suggested hoisting _before_ injection was viable (injection reached the
  relocated const), but a fixture audit found it silently truncated the
  argSchema in nested / multi-capture lifts: SchemaInjection derives the
  argument schema from the _applied captures object_ (`call.arguments[0]` of the
  outer application), which hoisting-before severs from the lift — the
  callback's parameter type alone does not recover all captures. Hoisting
  _after_ injection bakes the complete schema into the still-applied
  `lift(argSchema, resSchema, cb)(captures)` first, so the relocation is
  schema-transparent. (Map-element `$ref` schemas regressed the same way under
  hoist-before and are likewise fixed by hoist-after.) See
  `session_outputs/2026-06-02_lift-hoist-phase2/02-ordering-correction.md`.
- **Interaction with the existing CT-1585 hoist.** **Subsume, verified.** Phase
  2 owns lift hoisting: `lift` is removed from CT-1585's
  `HOISTABLE_BUILDER_NAMES` and the lift-applied branch in `resolveHoistTarget`
  is disabled. Coexistence produced a double-hoist that TDZ-crashed at module
  load (`Cannot access
  '__cfModuleCallback_1' before initialization` — Phase
  2's lift const hoisted above CT-1585's callback const). CT-1585 still owns
  `pattern`/`handler`/ `patternTool`; both coexist correctly in one file (e.g.
  `patternTool` callback stays `__cfModuleCallback_N` while sibling lifts become
  `__cfLift_N`). When `pattern`/`handler` get whole-call hoisting they fold into
  `LiftHoistingTransformer`.
- **Naming collision.** Names come from a per-file counter plus
  `factory.createIdentifier("__cfLift_" + n)`. The `__cfLift` prefix is added to
  `isTransformerInjectedIdentifier` so that a `__cfLift_N` reference appearing
  inside another hoisted callback is not miscounted as a user module-scope use.
- **Call-site recognition.** The synthetic `__cfLift_N(captures)` identifier has
  no checker symbol, so its identity is carried on the node:
  `ts.setOriginalNode(name, innerCall)` plus a `getOriginalNode` fallback in
  `resolveBuilderExpressionKind`. This lets `detectCallKind` still classify the
  application as lift-applied, so `ReactiveVariableForTransformer` continues to
  attach the `.for(...)` tail.
- **`createUniqueName` trap.** Avoided — explicit counter + `createIdentifier`,
  per CT-1585 commit 3.

### Inputs to Phase 3 (selfcontained)

After CT-1644, every reactive lift is a module-scope
`const __cfLift_N = __cfHelpers.lift(argSchema, resSchema, cb)` with the
callback inline — the exact substrate Phase 3 wraps as
`__cfHelpers.lift(__cfHelpers.selfcontained(...))`. The sandboxability predicate
is CT-1585's `analyzeCallbackForHoisting` machinery (the `localNames` pre-pass,
`isTransformerInjectedIdentifier`, the ambient-globals exclusion), now
repurposed from a _hoist gate_ to a _selfcontained gate_ applied to each
`__cfLift_N`'s inline callback body.

## Phase 3: selfcontained marker (sketch)

_(The marker was called `sandboxable` in early drafts; Berni picked
`selfcontained` 2026-05-21. Same concept — this section uses the final name.)_

After Phase 2: every reactive lift-style computation is a module-scope
`const __cfLift_N = __cfHelpers.lift(...)`. Phase 3 inspects each `__cfLift_N`'s
callback body and, for the ones that meet the selfcontained conditions, wraps
the lift's arguments in `__cfHelpers.selfcontained(...)`:

```ts
const __cfLift_N = __cfHelpers.lift(
  __cfHelpers.selfcontained(
    { inputSchema },
    { outputSchema },
    ({ x }) => x + 1,
  ),
);
```

Note: the wrapper is _inside_ the `lift(...)` call's argument list —
`__cfHelpers.lift(__cfHelpers.selfcontained(args))` — not wrapping the lift
itself. (Berni's preference.)

### Selfcontained conditions (initial proposal, subject to confirmation with Berni)

A `__cfLift_N` is selfcontained if its callback body:

1. Closes over **zero** user-authored module-scope variables. References to
   user-authored module-level functions, constants, classes, etc. disqualify it.
   (Even though those references are statically resolvable at sandbox boot, they
   require sandbox infrastructure to load the surrounding module, which defeats
   the "transient sandbox" goal.)
2. Closes over **zero** enclosing-function-scope variables that _aren't_
   threaded through the input-object argument. Post-Phase-1, the closure
   transformer should already have ensured all captures flow through inputs —
   but verify per body.
3. Uses only:
   - Its own parameters (the destructured input-object).
   - Transformer-injected helpers (`__cfHelpers.*`, `__cfHardenFn*`) — these are
     part of the sandbox bootstrapping by definition.
   - Ambient globals (`console`, `Math`, `JSON`, `Object`, `Array`, etc. —
     declarations in `lib.*.d.ts`). Non-deterministic globals (`Date.now()`,
     `Math.random()`, `console.log()`) don't disqualify a body structurally —
     they are ambient and capture no user-authored variable. (The runtime now
     capability-gates the clock and entropy: `Date.now()`/`Math.random()` throw
     inside a lift body rather than routing through the retired
     `safeDateNow`/`unsecureRandom` helpers; only `console.log` remains
     scaffolding.)

The detection logic should reuse the building blocks from CT-1585's hoister:

- `analyzeCallbackForHoisting`'s structural pre-pass (the `localNames` set)
  generalizes cleanly.
- `isTransformerInjectedIdentifier` already exists.
- The ambient-global check (every declaration in a `.d.ts` source file) already
  exists.

### Open questions for Phase 3

- **Naming.** ~~`sandboxable` is the placeholder.~~ **Resolved (Berni
  2026-05-21): `selfcontained`.** The wrapper helper is
  `__cfHelpers.selfcontained(...)`.
- **The "addressable" goal.** **Resolved (Berni 2026-05-21):** the addressable
  identity is `<bundlehash>/<filename>/<symbol>` (or a hash of the selfcontained
  function / inline). The Phase 2 module-scope const gives the `<symbol>` part;
  Phase 3 / the runtime supply the rest. Not blocking the transformer marker.
- **Non-deterministic globals in selfcontained bodies.** **Resolved (Berni
  2026-05-21): allowed.** `console.log`, `safeDateNow`, `unsecureRandom` are all
  fine — they're injected, so they count as transformer/sandbox scaffolding, not
  disqualifying captures. **Superseded by the W1/W6 timing gate:**
  `safeDateNow`/`unsecureRandom` are removed and the clock/entropy intrinsics
  now throw inside a lift body at runtime (only `console.log` remains
  scaffolding); they stay structurally non-disqualifying for the transformer.
- **Selfcontained gate conditions.** Still wants a final confirm from Berni that
  "zero user-authored module-scope variables + zero enclosing-scope captures
  outside the input object + only globals + transformer scaffolding + own
  params" is the right gate (see the conditions list above and the tracker
  entry).
- **What does the runtime do with `selfcontained`?** Out of scope for the
  transformer, but the runtime contract (how a `selfcontained`-wrapped lift is
  moved across a sandbox boundary) informs which conditions are load-bearing. No
  runtime-side doc exists yet — worth writing alongside the Phase 3 runtime
  work.

(See the "Open questions tracker" at the end of this doc for the dated
resolutions.)

## Glossary of the building blocks in the existing code

Quick reference for the current code. All paths are relative to
`packages/ts-transformers/`.

| Concept                                      | Where it lives                                                                          | Notes                                                                                                                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pipeline stage order                         | `src/cf-pipeline.ts` (`CFC_TRANSFORMER_STAGES`)                                         | The 27-stage registry is authoritative; prose synchronization is pinned by `test/spec-sync.test.ts`.                                                                     |
| `LiftLoweringTransformer`                    | `src/lift/transformer.ts`                                                               | Stage 13. Lowers `computed(...)` (and formerly user `derive(...)`) to the lift-applied form.                                                                             |
| `ClosureTransformer`                         | `src/closures/transformer.ts`                                                           | Stage 14. The main reactive lowering; extracts captures into the lift input object.                                                                                      |
| `createLiftAppliedCall`                      | `src/transformers/builtins/lift-applied.ts`                                             | Factory for synthesized lift-style helper calls; emits `lift<In,Out>(cb)(input)`.                                                                                        |
| `BuilderCallHoistingTransformer`             | `src/transformers/builder-call-hoisting.ts`                                             | Stage 20, after schema injection. Sole module-scope hoister for applied `lift`/`handler` calls and argument-position `pattern` calls, including `patternTool`'s pattern. |
| `detectCallKind` (`kind === "lift-applied"`) | `src/ast/call-kind.ts`                                                                  | Centralized call classifier. The `__cfLift` original-node fallback preserves classification after hoisting.                                                              |
| `SchemaInjectionTransformer`                 | `src/transformers/schema-injection.ts`                                                  | Stage 19. Derives the argument schema from the applied captures object before hoisting relocates the inner builder call.                                                 |
| Pattern-test runtime                         | `tasks/integration.ts` (`runPatternTests`)                                              | Runs `deno task cf test --root packages/patterns ...` to validate runtime behavior of hoisted/selfcontained lifts.                                                       |
| SES bundle verifier (lift)                   | `packages/runner/src/sandbox/compiled-bundle-verifier.ts` (`callbackIndexesForBuilder`) | Verifies trusted-builder calls in compiled bundles, including the two-argument `lift(false, fn)` form.                                                                   |
| CT-1585/CT-1644 regression coverage          | `test/closures/module-scope-helper-hoisting.test.ts`                                    | Historical callback-hoist cases updated to the current whole-call hoist shape.                                                                                           |

## Past lessons worth carrying forward

From CT-1585's investigation, captured here so the Phase 1 implementer doesn't
have to rediscover:

- **`ts.factory.createUniqueName(prefix)` returns identifiers whose `.text` is
  the bare prefix.** Numeric suffixes are added only by the printer at emit
  time. Anywhere in the pipeline that matches identifiers by `.text` will treat
  all calls with the same prefix as the same identifier. Use an explicit
  per-file counter + `factory.createIdentifier(` ${prefix}_${n}`)` instead. See
  CT-1585 commit 3 for context.
- **`node.getText()` crashes on synthetic nodes (`pos === -1`).** Use
  `getExpressionText` from `src/ast/utils.ts` for safe printing.
- **`isDeclaredWithinFunction` (in `ast/scope-analysis.ts`) has a documented
  synthetic-node hazard** — symbol-resolved declarations from the source AST
  don't match position-based comparisons against synthesized callbacks. CT-1585
  commit 1 worked around this with a `localNames` structural pre-pass; the same
  hazard applies to any new transformer that asks "is this binding declared
  inside this synthesized scope?"
- **Trace-driven investigation pays off.** When something downstream of a
  transform produces unexpected output, instrument the relevant code paths with
  `console.error` filtering on a specific body-text substring. Always revert
  traces before committing.
- **Verify hypotheses with failing tests before fixing.** CT-1585's most
  expensive mistake was committing to a fix shape (the "early gate" hypothesis)
  before tracing actual behavior. The fix turned out to be in a completely
  different code path.

## Filing tickets

- **Phase 1: CT-1615** (Done) — rewrite `derive` calls to the lift-applied form.
- **Phase 2: CT-1644** — hoist every lift call to module scope.
- **Phase 3: CT-1654** — wrap selfcontained lifts with
  `__cfHelpers.selfcontained(...)`. Note: blocked on a `selfcontained` runtime
  helper that does not exist yet (no `packages/runner` impl, no `__cfHelpers`
  export) — the ticket tracks that as a prerequisite sub-task.
- Adjacent / fed-from-this-work: CT-1643 + CT-1624 (`derive` retirement, Done),
  CT-1625 (lift type-surface duplication), CT-1634 (direct-`lift(fn)` schema
  gap), CT-1652 (dead `derive` case in the SES bundle verifier).

## Open questions tracker

These are explicitly open and should be resolved (or explicitly punted) before
the relevant phase lands.

- **[Phase 1]** Verify `lift` and `derive` are runtime synonyms. **Verified
  2026-05-21**: `derive(input, f)` is literally `lift(f)(input)` at runtime
  (`packages/runner/src/builder/module.ts:441-476`).
- **[Phase 1]** Verify the closure transformer already routes all derive
  captures through the input-object argument. Find any residual lexical-capture
  cases and decide their disposition. **Implicitly verified 2026-05-22**: Phase
  1 landed with all 288 ts-transformers fixture tests passing AND the three
  runtime repros from CT-1585 passing (`packages/patterns/notes/note.test.tsx`,
  `notebook.test.tsx`, `factory-outputs/parking-coordinator/main.test.tsx`). The
  lift-applied form is structurally `lift(cb)(input)`; if any callback had a
  residual lexical-capture-without-input case, the runtime's connect-time check
  (`packages/runner/src/builder/node-utils.ts:15-18`) would throw "Reactive
  reference from outer scope cannot be accessed via closure" — that error is
  absent in all test runs.
- **[Follow-up after Phase 1]** Investigate the redundant schema re-narrowing in
  `schema-injection.ts` line 3285 (the
  `kind === "builder" && builderName === "lift"` branch with
  `isToSchemaCall(firstArgument)`). When `ts.visitEachChild` re-enters our own
  injected lift-applied output, this branch fires a _second_ narrowing pass on
  synthetic schema TypeNodes we just produced. CT-1615 worked around this by
  registering synthetic wrapper TypeNodes against their semantic types in
  `applyShrinkAndWrap` (so the second pass becomes idempotent rather than
  degraded). The underlying smell: re-narrowing on freshly-injected output is
  structurally redundant. Likely cleaner shape: detect that the call came from
  our own injection (via `ts.getOriginalNode` plus an injection tag) and skip
  the re-narrowing entirely. Defer to a separate investigation post-Phase 1 —
  needs to confirm the branch isn't load-bearing for truly user-authored
  `lift(toSchema(...), toSchema(...), cb)` calls (rare but possible). **Tracked
  as
  [CT-1621](https://linear.app/common-tools/issue/CT-1621/remove-redundant-schema-re-narrowing-in-schema-injections-inner-lift)**
  after Berni's review on PR #3676 (section 7.3).
- **[Phase 3]** Final name for `sandboxable` (TL). **Berni 2026-05-21**: prefers
  `selfcontained`.
- **[Phase 3]** Are non-deterministic globals (`Date.now()`, `Math.random()`) OK
  in sandboxable bodies? (Berni.) **Berni 2026-05-21**: yes — `console.log`,
  `safeDateNow`, `unsecureRandom` all fine; they're injected. **Superseded:**
  the runtime now throws for the clock/entropy intrinsics inside a lift body
  (W1/W6 gate), and `safeDateNow`/`unsecureRandom` are removed.
- **[Phase 3]** Is the module-scope const enough for the "addressable" goal, or
  do we need stable cross-version identity (content hash)? (Berni.) **Berni
  2026-05-21**: `<bundlehash>/<filename>/<symbol>` (or hash of the selfcontained
  function / inline).
- **[Phase 3]** Sandboxable conditions: confirm with Berni that "zero
  user-authored module-scope variables + zero enclosing-scope captures outside
  the input object + only globals + transformer scaffolding + own params" is the
  right gate.
- **[DONE — PR #3709]** Move transformer output from `lift(...)({})` to the
  no-input form. Shipped as `lift(false, fn)()` (not a bare `lift(fn)()`: the
  runner skips a no-arg lift unless `argumentSchema === false`, so the explicit
  `false` is required — it mirrors `computed`'s runtime semantics). Added a
  2-arg `lift(argumentSchema, implementation)` overload (runtime +
  `LiftFunction` type). The rewrite is gated in schema-injection's
  `prependSchemaArguments`, AFTER ClosureTransformer, so it fires only for
  genuinely zero-capture computeds (empty outer input); captured computeds keep
  `lift(fn)({...refs})`.
- **[DONE — CT-1643 + CT-1624]** Remove `derive` from transformer and runtime
  exports. The lift-applied form is now the sole lowered/runtime shape; the
  preceding note records the uncertainty before those tickets landed.
- **[Follow-up]** Collapse the `lift` type-surface duplication: the overloads
  are declared in BOTH `module.ts` and the `LiftFunction` interface
  (`packages/api`), mirrored by hand (PR #3709 had to add the new overload to
  both). Consider typing the runtime builders _as_ their facade interfaces for a
  single source of truth.
- **[DONE — PR #3707, registry architecture]** Consolidated the cross-stage
  registries into a single `CrossStageState` object (audit:
  `docs/scratch/07-registry-audit.md` — scratch dir since deleted, see git
  history; design: `12-registry-unification-design.md`). Outcome differed from
  the original tiered plan in two evidence-driven ways: (1) the `typeRegistry`
  three-way split was investigated and **dropped** — the three uses are isolated
  by key node-kind (replacement-Expr / TypeNode / CallExpression never
  coincide), so the split fixed no reachable bug; the invariant is documented
  instead. (2) `syntheticLiftAppliedCallRegistry` was **removed** as
  verified-inert. The remaining channels (which at the time of #3707 still
  included `narrowedWrapperTypeRegistry` — see postscript) now live in
  `CrossStageState`, accessed via record/lookup/mark methods; cache-invalidation
  stays on the context. `typeRegistry` + `schemaHints` remain plain maps at the
  schema-generator package boundary.

  _Postscript (post-#3788):_ `narrowedWrapperTypeRegistry` was subsequently
  retired by CT-1621. PR #3716 added the `schemaInjectedRegistry` marker that
  catches schema-injection re-entries on nodes whose mark survived. PR #3788
  then closed the residual case (synthetic capability-wrapper re-entries whose
  mark didn't survive, e.g. authored `lift(cb)(value)` whose toSchema arg
  arrives at the `isToSchemaCall` branch as `__cfHelpers.ComparableCell<…>` with
  `pos < 0`) by detecting it structurally and short-circuiting the redundant
  re-shrink — which left the channel without a consumer and let it be deleted.
  The current CrossStageState inventory is maintained in
  `src/core/cross-stage-state.ts` and summarized in the behavior spec §2.2.
  Note: the earlier session-prep doc framed the registry as "derive-bound, dies
  with derive removal"; that was wrong — the consumer was schema-injection's own
  re-entry on user-authored `lift`, not a derive-specific shape.
