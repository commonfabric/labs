# First-Class Serializable Factories — Implementation Plan

Status: Not started

This plan implements
[First-Class Serializable Factories](../specs/pattern-construction/node-factory-shipping.md).
Read that specification first: it defines the behavior and invariants; this
document defines the implementation sequence. If the two disagree, update the
plan or stop for a design decision rather than changing the contract implicitly.

The work is independent of graph snapshots and the reactive-interpreter
migration. In particular, Stage 0 copies or reimplements only the generic
`$patternRef` behavior identified from #4514; it does not merge or depend on the
rest of that branch.

## Status convention

- [ ] Not started
- [x] Complete and verified

Mark a parent checkbox complete only after all of its child checks and its
completion gate pass. Keep this live plan updated in the same commits as the
implementation. When the final removal gate passes, archive it under
`docs/history/plans/` following `docs/README.md`.

## How to execute this plan

- Work stages in order. Tasks within a work package are dependency ordered
  unless explicitly marked parallel-safe.
- Use red/green TDD for every behavioral slice: add the focused failing test,
  confirm the failure is for the intended missing behavior, implement the
  smallest coherent change, then refactor.
- Commit by numbered work package or smaller coherent subtask. Do not combine a
  data-model protocol change, transformer lowering, and source migration in one
  commit.
- Run the affected package's complete test task before completing a work
  package. Run the cross-package gates at the end of every stage.
- For transformer changes, inspect emitted code with
  `deno task cf check <fixture>.tsx --show-transformed --no-run`; do not infer
  the emitted IR from transformer source alone.
- Treat `Factory@1` as a wire format. Any field or validation change requires a
  spec review, encode/decode fixtures, and an explicit compatibility decision.
- Keep legacy readers until their removal gates pass, but switch each writer to
  the new representation as soon as its stage lands.
- Preserve the public rule that authors create another inline pattern to add a
  binding layer. `.curry(params)` is transformer-only, one-shot, and absent from
  the public API throughout this plan.

## Fixed design constraints

- [ ] Use one directly branded callable `Factory@1` value for pattern, module,
  and handler factories; do not introduce `FabricPatternFactory`,
  `FabricModuleFactory`, or another wrapper object.
- [ ] Keep the factory artifact ref distinct from `$implRef`; only the complete
  content-addressed builder artifact can back durable factory state.
- [ ] Decode to a branded, inert callable shell. Only runner-owned
  `materializeFactory` may turn a shell into an executable builder factory.
- [ ] Keep public pattern input in callback argument 0 and closure params in
  callback argument 1. Never merge the two records.
- [ ] Carry the compiler-generated params schema with
  `withPatternParamsSchema(callback, schema)` before `pattern()` eagerly invokes
  the callback; do not add a fourth `pattern()` argument.
- [ ] Emit `.curry(params)` only from the transformer, with exactly one
  argument, no argument index, and a hard error on a second call.
- [ ] Permit durable encoding only when the root artifact has a cold-resolvable
  content-addressed `{ identity, symbol }` ref. Reject keyless, action-created,
  and host-pseudo-module factories.
- [ ] Keep the dynamic call site's output spot as the stable identity anchor
  when the selected factory changes.
- [ ] Preserve `FrameworkProvided` inputs as system-supplied inputs through
  wrapper chains; reject authored or captured attempts to provide them.

## Dependency map

| Stage | Delivers | Depends on |
| --- | --- | --- |
| 0 | Generic `$patternRef` binding and direct setup resolution | Current `main` |
| 1 | Branded, serializable, materializable factory values | Stage 0 |
| 2 | `asFactory` schemas and dynamic symbolic invocation | Stage 1 |
| 3 | Nested-pattern closure conversion and hidden params root | Stages 1–2 |
| 4 | Boundary/tool migration and `patternTool` writer removal | Stages 1–3 |
| 5 | Compatibility-reader removal and final documentation | Stored-data and rollout gates |

The API/schema-generator work in Stage 2 may start in parallel with the runner
dynamic-node work after Stage 1's canonical state is fixed. Stage 3 must not
invent a second factory representation while waiting for Stage 2.

## Stage 0 — Extract generic `$patternRef` binding

### WP0.1 — Audit and isolate the #4514 prerequisite

Reference commits: `3b028c786`, `39b213e63`, and `ede6c5a7d`.

- [ ] Compare each reference commit against current `main`; record which hunks
  are already present and which semantic tests still fail.
- [ ] Copy or reimplement only changes touching generic pattern-value binding,
  executable lookup, and direct setup/sub-pattern resolution.
- [ ] Explicitly exclude reactive-interpreter dispatch, strict-interpreter-only
  rewrites, or unrelated runner refactors from the port.
- [ ] Keep current runner behavior outside the new `$patternRef` cases byte-for-
  byte or test-for-test equivalent.

Expected implementation files:

- `packages/runner/src/pattern-binding.ts`
- `packages/runner/src/runner.ts`
- `packages/runner/src/builtins/op-pattern-ref.ts`
- `packages/runner/src/harness/executable-registry.ts` only if the current
  executable lookup still needs the generic artifact path

### WP0.2 — Bind nested pattern values by reference

- [ ] Add a red test showing an addressable pattern nested in an object/array
  binding is replaced with a `$patternRef` sentinel rather than copied as an
  inert graph.
- [ ] Preserve `argumentSchema` and `resultSchema` on the sentinel.
- [ ] Preserve derivation provenance so a serialized copy still resolves its
  root artifact ref after registration.
- [ ] Cover direct, nested, repeated, and aliased occurrences without changing
  ordinary object traversal.
- [ ] Preserve the current legacy graph fallback for a keyless pattern; the new
  durable `Factory@1` identity rejection belongs to Stage 1, not this
  prerequisite port.

Tests to port or extend:

- `packages/runner/test/pattern-binding.test.ts`
- `packages/runner/test/pattern-node-patternref.test.ts` (new if still absent)

### WP0.3 — Resolve a sentinel passed directly to setup/run

- [ ] Add a red test for a `$patternRef` handed directly to sub-pattern setup,
  not only nested inside another binding.
- [ ] Resolve synchronously from the artifact index when warm.
- [ ] Fall back to the existing storage-backed identity loader when cold.
- [ ] Validate the resolved value is a trusted pattern with matching schemas.
- [ ] Ensure a missing or wrong-kind ref fails closed and includes identity and
  symbol in the diagnostic.

Tests to port or extend:

- `packages/runner/test/pattern-tool-invoke-boundary.test.ts`
- `packages/runner/test/pattern-ref-boundary.test.ts`
- `packages/runner/test/stored-pattern-rehydration.test.ts`

### Stage 0 completion gate

- [ ] The three reference commits are not ancestors of this work by accident;
  only reviewed prerequisite behavior has been reproduced.
- [ ] `deno test` passes for the focused Stage 0 runner tests.
- [ ] `deno task test` passes in `packages/runner`.
- [ ] No Stage 0 code depends on reactive-interpreter-only types or flags.
- [ ] Commit the stage as a standalone, revertible prerequisite.

## Stage 1 — Branded callable Fabric values

### WP1.1 — Define the dependency-light factory protocol

- [ ] Add the `FabricFactory` callable arm to the `FabricValue` union in
  `packages/data-model/src/api.ts`, which `packages/api/index.ts` re-exports.
- [ ] Define the `FactoryStateV1` discriminated union with exactly the fields in
  the specification: shared `ref`; pattern schemas/params/scope/space selector;
  module schemas/scope; and handler context/event schemas.
- [ ] Add internal live-state support with a stable root token and an optional,
  not-yet-sealed ref. Keep live state out of the public wire type.
- [ ] Add one module-private admission/state table and shared
  `tryFactoryState()` / `factoryStateOf()` access path. A copied symbol property
  must not pass admission.
- [ ] Provide an internal registration API for trusted builder constructors and
  codec-created shells without granting runner execution trust.
- [ ] Keep all properties used for branding/state access non-enumerable and do
  not modify `Function` or `Function.prototype`.
- [ ] Export only the minimum protocol surface needed by the runner and codec;
  do not expose `.curry` or state mutation to pattern authors.
- [ ] Re-export the runner-facing protocol through
  `packages/data-model/src/index.ts` without creating a dependency from the
  data model back into the runner.

Expected implementation files:

- `packages/data-model/src/api.ts`
- a new dependency-light module such as
  `packages/data-model/src/fabric-factory.ts`
- `packages/data-model/deno.jsonc` export map
- `packages/api/index.ts`

### WP1.2 — Add `Factory@1` codec dispatch

- [ ] Add the `Factory@1` constant to
  `packages/data-model/src/codec-interface/codec-type-tags.ts`.
- [ ] Implement a `FactoryCodec` with wire tag `Factory@1`.
- [ ] Validate discriminant, exact allowed fields, content-addressed ref shape,
  schemas, modifiers, and pattern-only params fields during decode.
- [ ] Decode to a frozen branded callable shell whose body throws
  `factory requires runner materialization` and whose state can be re-encoded.
- [ ] Add a dedicated callable-factory codec slot to
  `packages/data-model/src/codec-common/CodecRegistry.ts`; do not classify all
  functions as primitives or match `Function` by constructor.
- [ ] Register the codec where the class rosters are applied, in
  `packages/data-model/src/codecs.ts`.
- [ ] Route callable factories through codec lookup before the generic function
  rejection.
- [ ] Include callable factories in JSON encoder cycle tracking.
- [ ] Reject arbitrary functions, copied brand symbols, malformed state,
  unknown kinds, extra fields, and cyclic state.

Expected implementation and test files:

- `packages/data-model/src/codec-common/` for the codec/state validator
- `packages/data-model/src/codec-common/CodecRegistry.ts`
- `packages/data-model/src/codec-json/JsonCodecEngine.ts`
- `packages/data-model/src/codecs.ts`
- `packages/data-model/test/codec-common/FactoryCodec.test.ts`
- `packages/data-model/test/codec-common/CodecRegistry.test.ts`
- `packages/data-model/test/codec-json/JsonCodecEngine.test.ts`
- a focused `packages/data-model/test/fabric-factory.test.ts`

### WP1.3 — Make every Fabric operation see the same factory state

- [ ] Update `packages/data-model/src/convertible-js.ts` so admitted
  factories are recognized through `tryFactoryState()`, and unbranded functions
  remain invalid. Codec dispatch remains the serialization layer's job.
- [ ] Update `packages/data-model/src/types/validation.ts` and compatibility
  guards so `FabricFactory` is the only valid function-shaped `FabricValue`.
- [ ] Update `packages/data-model/src/deep-freeze.ts` to seal/freeze canonical
  state and then freeze the callable. Factory handling must precede the current
  shortcut that treats functions as already frozen.
- [ ] Update `packages/data-model/src/value-clone.ts` so canonical factories are
  immutable logical atoms and both mutable/frozen clone requests preserve the
  same canonical factory.
- [ ] Update `packages/data-model/src/valueEqual.ts` to compare canonical codec
  state rather than function identity, before any same-reference shortcut that
  could accidentally admit an arbitrary function.
- [ ] Update `packages/data-model/src/value-hash/ValueHasher.ts` to hash the `Factory@1` tag
  and recursively hashed canonical state.
- [ ] Ensure all of these paths call the shared state/codec visitor rather than
  independently enumerating hidden fields.
- [ ] Make encode, hash, equality, and Fabric deep-freeze fail before a live
  factory's artifact ref can be sealed.
- [ ] Verify sealing memoizes one immutable state and a stable hash.

Focused tests:

- `packages/data-model/test/convertible-js.test.ts`
- `packages/data-model/test/types/validation.test.ts`
- `packages/data-model/test/deep-freeze.test.ts`
- `packages/data-model/test/cloneIfNecessary.test.ts`
- `packages/data-model/test/cloneForMutation.test.ts`
- `packages/data-model/test/shallowMutableClone.test.ts`
- `packages/data-model/test/value-clone.test.ts`
- `packages/data-model/test/valueEqual.test.ts`
- `packages/data-model/test/value-hash/impl.test.ts`

Each suite must cover all three factory kinds, nested factory state, independent
but equal decoded shells, pre-seal failure, and arbitrary-function rejection.

### WP1.4 — Attach canonical state in runner builders

- [ ] Brand the function returned by `pattern()` in
  `packages/runner/src/builder/pattern.ts` as kind `pattern`.
- [ ] Brand functions returned by `createNodeFactory()`, including `lift()`,
  `byRef()`, raw/builtin factories, and equivalent helpers, as kind `module`.
- [ ] Brand `handler()` results as kind `handler` while retaining separate
  `contextSchema` and `eventSchema` before the internal `$ctx`/`$event` schema
  combination.
- [ ] Populate state from the complete builder descriptor, never from
  `moduleToEncodableForm(...).$implRef`.
- [ ] Reuse or generalize the derivation/root tracking in
  `packages/runner/src/builder/pattern-metadata.ts` so `asScope()`, `inSpace()`,
  later `.curry()`, and traversal copies share one root token and late ref.
- [ ] Make `asScope()` and every `inSpace()` selector form create a new branded
  factory whose canonical state includes the modifier without resolving a raw
  selector prematurely.
- [ ] Seal through `getArtifactEntryRef(root)` after `PatternManager` indexes
  the verified export or `__cfReg` artifact.
- [ ] Make `setArtifactEntryRef()` feed the root token's late-ref state so a
  derived factory created before registration seals against the same canonical
  artifact without introducing a data-model-to-runner dependency.
- [ ] Reject durable encoding of keyless/manual, action-created, and `host:<n>`
  pseudo-module factories.
- [ ] Preserve existing direct live invocation behavior before and after state
  attachment.

Focused tests:

- `packages/runner/test/factory-input-types.test.ts`
- `packages/runner/test/pattern-provenance.test.ts`
- `packages/runner/test/pattern-scope.test.ts`
- `packages/runner/test/host-pseudo-module.test.ts`
- new `packages/runner/test/factory-state.test.ts`

### WP1.5 — Traverse hidden factory state during graph construction

- [ ] Adapt the shared visitor/accessor from
  `packages/data-model/src/fabric-factory.ts` for builder traversal; runner code
  supplies alias mapping and derived-callable construction but does not define
  a second state view.
- [ ] Integrate it into `packages/runner/src/builder/traverse-utils.ts` and
  `packages/runner/src/builder/to-encodable-form.ts` before generic function handling.
- [ ] Preserve live, pre-ref factory state during internal graph serialization;
  sealing belongs at a later durable Fabric boundary, after artifact indexing.
- [ ] Convert captured Cells/Reactives to aliases inside factory state.
- [ ] Descend into nested factories without exposing enumerable `curried` or
  state fields.
- [ ] Keep CFC inspection and alias traversal on the same logical state view as
  serialization, hashing, and equality.
- [ ] Verify two references to the same factory do not cause false cycle errors,
  while an actual cycle through params is rejected.
- [ ] Review graph payload fields in `packages/runner/src/builder/types.ts` and
  static-data walks in `packages/runner/src/cell.ts` so hidden factory state is
  neither flattened nor skipped.
- [ ] Verify `packages/runner/src/storage/differential.ts`,
  `packages/runner/src/storage/v2-transaction.ts`, and
  `packages/memory/v2/patch.ts` treat factories atomically through the shared
  equality/clone protocol.
- [ ] Once canonical factory traversal is available, switch durable
  factory-valued binding from Stage 0's `$patternRef` sentinel to `Factory@1`.
  Constrain `$patternRef` emission to explicitly legacy/internal graph fallback
  paths and add a test that new durable factory writes cannot choose it.

### WP1.6 — Add runner-owned factory materialization and generic resolution

- [ ] Generalize `PatternManager.loadPatternByIdentity()` into, or layer it on,
  a generic `loadArtifactByIdentity(identity, symbol, space)` path that returns
  only trusted indexed builder artifacts.
- [ ] Preserve warm artifact-index lookup, storage-backed cold loading,
  single-flight behavior, `__cfReg` symbol resolution, and CFC verification.
- [ ] Keep a pattern-specific wrapper temporarily for existing callers.
- [ ] Implement the runner chokepoint
  `materializeFactory(value, runtime)` with warm and async-cold forms as needed.
- [ ] Return live factories unchanged when their trusted kind/state already
  match.
- [ ] For decoded shells, resolve the trusted base artifact, compare kind and
  normalized schemas, reapply scope/space modifiers, retain canonical codec
  state, and return a callable builder factory.
- [ ] Keep schema-light module factories unresolved until a trusted
  `ModuleRegistry` entry supplies schemas; never promote wire or call-site
  hints to execution authority.
- [ ] Until Stage 3 lands, fail materialization closed for decoded pattern state
  containing `paramsSchema` or `params`; Stage 1 may validate and re-encode that
  state but cannot yet reconstruct its runtime binding semantics.
- [ ] Reject missing refs, wrong kinds, schema mismatches, forged metadata, and
  non-factory values with stable diagnostics.

Expected files and tests:

- `packages/runner/src/pattern-manager.ts`
- a focused runner module such as
  `packages/runner/src/factory-materialization.ts`
- `packages/runner/test/pattern-manager.test.ts`
- `packages/runner/test/fabric-imports-pattern-manager.test.ts`
- new `packages/runner/test/factory-materialization.test.ts`

### WP1.7 — Prove context-free and runner-aware round trips

- [ ] Round-trip pattern, module, and handler factories through context-free
  JSON and confirm decode returns inert callable shells.
- [ ] Re-encode each shell without a runner and get identical canonical state.
- [ ] Materialize each shell in a warm runner and invoke it through its existing
  direct path.
- [ ] Cold-load each kind in a fresh runtime from the content-addressed module
  identity.
- [ ] Round-trip factories nested in plain arrays/objects and synthetic decoded
  factory state. Typed Cell/piece coverage waits for Stage 2 `asFactory`, and
  live bound-pattern params wait for Stage 3's internal curry and params root.
- [ ] Preserve `asScope()` and named, anonymous, and cell-derived `inSpace()`
  selectors across the round trip.
- [ ] Verify equal state hashes equally across independent verified module
  evaluations.

### WP1.8 — Update the live Fabric protocol documentation

- [ ] Update `docs/specs/space-model-formal-spec/1-fabric-values.md` when the
  callable Fabric arm lands.
- [ ] Update `docs/specs/space-model-formal-spec/3-json-encoding.md` with the
  exact `Factory@1` tag, validated state, and inert context-free decode.
- [ ] Pin `Factory@1` to the existing codec-instance byte arm in
  `docs/specs/space-model-formal-spec/2-hash-byte-format.md`; do not invent a
  factory-specific hash encoding.
- [ ] Keep the proposal's status accurate for the still-unimplemented dynamic
  invocation and closure stages.

### Stage 1 completion gate

- [ ] `Factory@1` is the only new wire tag and no wrapper factory type exists.
- [ ] All three trusted factory constructors attach state and direct invocation
  remains green.
- [ ] Arbitrary functions and pseudo refs are still rejected.
- [ ] Context-free decode is inert; runner materialization is the only path to
  executable behavior.
- [ ] `deno task test` passes in `packages/data-model` and `packages/runner`.
- [ ] `deno check packages/api/index.ts` (or the package's standard type-check)
  passes with `.curry` absent from public `PatternFactory`.
- [ ] Commit Stage 1 in protocol, builder-state, and materialization slices.

## Stage 2 — Factory schemas and symbolic invocation

### WP2.1 — Add `asFactory` to the public schema vocabulary

- [ ] Extend `JSONSchemaObj` in `packages/api/index.ts` with a discriminated
  `asFactory` definition for `pattern`, `module`, and `handler`.
- [ ] Use `argumentSchema`/`resultSchema` for pattern and module kinds and
  `contextSchema`/`eventSchema` for handler kind.
- [ ] Define one schema normalization/equality helper for trusted factory
  comparisons; version 1 requires equality, not variance.
- [ ] Update schema validation/resolution utilities that copy, merge, sanitize,
  or format Common Fabric extensions so `asFactory` is preserved.
- [ ] Teach `Schema<T>` / `SchemaWithoutCell<T>` in
  `packages/api/schema.ts` to materialize `asFactory` as the matching generic
  `PatternFactory`, `ModuleFactory`, or `HandlerFactory`.
- [ ] Ensure `asFactory` composes correctly with refs/definitions and does not
  silently become `asCell`.
- [ ] Add public type assertions in `packages/api/test/factory-input-types.test.ts`
  and `packages/api/index.test.ts` proving factories are `FabricValue`s, schema
  inference preserves their generics, and `.curry` is unavailable.

### WP2.2 — Generate schemas for all factory kinds

- [ ] Teach `packages/schema-generator/src/formatters/object-formatter.ts` to
  recognize `PatternFactory`, `ModuleFactory`, and `HandlerFactory` before its
  generic callable and callable-return-wrapper cases.
- [ ] Prefer one dedicated factory detector/formatter, registered before union,
  intersection, and object formatting, so aliases and branded intersections
  cannot fall through to generic callable handling.
- [ ] Extract public input/output schemas from the factory type arguments.
- [ ] Ensure `HandlerFactory` emits `contextSchema`/`eventSchema` and is not
  mistaken for `{ asCell: ["stream"] }` merely because its call signature
  returns a stream.
- [ ] Preserve schemas for aliases, properties, arrays/maps of factories, and
  factory unions used only as stored/returned values, using `anyOf` or the
  schema generator's equivalent union representation.
- [ ] Keep storage representability separate from callability: cross-kind or
  schema-varying unions are rejected only when WP2.3 tries to invoke them.
- [ ] Add fixtures covering factory-valued inputs, outputs, captures, nested
  containers, `byRef()`, and all three kinds.

Expected tests:

- a new `packages/schema-generator/test/schema/factory-types.test.ts`
- paired fixtures under `packages/schema-generator/test/fixtures/schema/`
- `packages/schema-generator/test/schema/factory-input-real-api.test.ts`
- `packages/schema-generator/test/fixtures-runner.test.ts`

### WP2.3 — Lower symbolic factory calls

- [ ] Add a type-directed callee classifier in `packages/ts-transformers` that
  distinguishes live imported/module-scoped factories from symbolic/reactive
  factory values.
- [ ] Follow local aliases, property access, and statically typed element access
  such as `const f = inputs.operation; f(x)` and
  `inputs.operations[key](x)`.
- [ ] Leave calls to live imported or module-scoped factories on the direct
  builder call path.
- [ ] Lower symbolic calls to internal `__cfHelpers.invokeFactory(factory,
  input, expectedSchema)`.
- [ ] Emit a pattern/module result as `Reactive` and a handler result as
  `Stream`, preserving handler `$ctx`/`$event` wiring.
- [ ] Reject a cross-kind union before graph construction and require normalized
  schema agreement for same-kind unions.
- [ ] Add a compile-time diagnostic for an untransformed symbolic factory proxy
  call.

Expected transformer seams:

- `packages/ts-transformers/src/ast/call-kind.ts`
- a centralized factory-kind/origin classifier under
  `packages/ts-transformers/src/ast/`
- the expression-site/type policy modules under
  `packages/ts-transformers/src/policy/`
- `packages/ts-transformers/src/transformers/structural-reactive-factory.ts`
- `packages/ts-transformers/src/transformers/schema-injection.ts`
- `packages/ts-transformers/src/cf-pipeline.ts`
- `packages/ts-transformers/src/core/commonfabric-runtime-registry.ts`
- helper registration/emission alongside existing `__cfHelpers`

Golden coverage must show exact direct-versus-symbolic output for aliases,
properties, element access, schema-light module refs, handlers, and unions.
Add dedicated fixtures for direct import, input field, local alias, property,
static element access, handler stream, compatible same-kind union, cross-kind
union, and schema mismatch; extend pipeline regression coverage so later
passes cannot undo the lowering.

### WP2.4 — Build the internal dynamic factory node

- [ ] Implement `invokeFactory` in the runner builder layer so it records a
  dynamic node whose module input is the symbolic factory value and whose
  expected kind/public schemas are explicit.
- [ ] Extend `NodeRef.module`/serialized node typing only as narrowly as needed;
  do not add another public factory wrapper.
- [ ] Complete the dynamic-module arm currently marked `TODO` in
  `packages/runner/src/runner.ts`.
- [ ] Resolve the factory cell value through `materializeFactory`, validate kind
  and trusted normalized schemas, then tail-call the existing pattern,
  JavaScript-module, or handler instantiation path.
- [ ] Resolve a schema-light `byRef()` through `ModuleRegistry`; fail if no
  trusted concrete schema is available.
- [ ] Apply pattern scope and raw space-selector modifiers after base resolution
  and before child instantiation.
- [ ] Do not execute implementation code during decode, value resolution, or
  property inspection.

### WP2.5 — Supervise replacement and teardown

- [ ] Make the factory cell a reactive dependency of one dynamic-node
  supervisor.
- [ ] Give each selected child/action/handler generation its own cancellation
  scope and monotonically increasing generation token.
- [ ] Add a scheduler/transaction generation guard: cancellation alone does not
  currently prevent an already-running async action from committing its final
  writes.
- [ ] On factory change, cancel the previous generation, fence late async
  writes/results, tear down result-owned internals and handler subscriptions,
  and instantiate the replacement.
- [ ] Preserve the call site's output binding and cause as the stable identity
  anchor across replacement.
- [ ] Verify two distinct call sites still receive distinct output identities.
- [ ] Cover replacement before settle, replacement after settle, same-factory
  replay, wrong-kind replacement, rejected cold load, and handler unsubscribe.
- [ ] Cover stale cold load A completing after B is selected, owner/piece
  teardown while load/action work is pending, invalid-then-valid replacement
  recovery, replacement-only handler stream routing, and cold resume with the
  selected factory and stable output identity.

Expected runtime tests:

- new `packages/runner/test/dynamic-factory-node.test.ts`
- `packages/runner/test/patterns-dynamic.test.ts`
- `packages/runner/test/patterns-handlers.test.ts`
- `packages/runner/test/by-identity-handler-exec.test.ts`
- `packages/runner/test/map-op-by-identity.test.ts`

Likely supervision seams include `packages/runner/src/cancel.ts` and the action,
subscription, and scheduler modules under `packages/runner/src/scheduler/`.

### WP2.6 — Materialize factories at runner exposure boundaries

- [ ] Route schema-driven `asFactory` Cell reads through the materialization
  chokepoint.
- [ ] Materialize recursively in query/result exposure without eagerly walking
  unrelated opaque data.
- [ ] Route graph binding and dynamic dispatch through the same helper.
- [ ] Preserve decoded shells at intentionally context-free data-model
  boundaries.
- [ ] Verify memory v1/v2 storage, patch/diff, and sync paths treat a canonical
  factory as an atomic codec value while still traversing its encoded state.
- [ ] Cover `packages/memory/v2.ts` `encodeMemoryBoundary` /
  `decodeMemoryBoundary` with a focused
  `packages/memory/test/v2-factory-boundary.test.ts` round trip.
- [ ] Add a fresh-runtime client/server round trip in which one runtime writes a
  factory, another decodes it, and a runner materializes/invokes it.
- [ ] Add typed factory round trips through Cells, query-result proxies, pieces,
  nested arrays, and nested objects now that `asFactory` exists.
- [ ] Verify cross-space links remain links and CFC labels survive resolution.

Concrete seams and focused tests:

- `packages/runner/src/cell.ts`
- `packages/runner/src/query-result-proxy.ts`
- the query/runtime adapters that expose decoded values
- `packages/runner/test/cell-proxy.test.ts`
- `packages/runner/test/query-result-proxy-fabric-primitive.test.ts`
- `packages/runner/test/query.test.ts`

### Stage 2 completion gate

- [ ] Factory-valued inputs, outputs, and stored cells carry `asFactory`.
- [ ] Symbolic pattern, module, and handler calls all use the same internal
  dynamic path.
- [ ] Direct live-factory calls have unchanged emitted code and behavior.
- [ ] Dynamic replacement cancels/fences the prior generation without changing
  the stable output spot.
- [ ] Warm and cold resolution fail closed on kind or schema mismatch.
- [ ] `deno task test` passes in `packages/api`, `packages/schema-generator`,
  `packages/ts-transformers`, and `packages/runner` using each package's
  available task names.

## Stage 3 — Pattern closure conversion

### WP3.1 — Add the compiler-only params-schema carrier

- [ ] Add internal `withPatternParamsSchema(callback, schema)` next to the
  builder helpers, backed by a private callback WeakMap or equally unforgeable
  protocol.
- [ ] Return the original callback so the helper can wrap the first argument of
  `pattern()` without changing public arity.
- [ ] Make `pattern()` and `patternFromFrame()` read the schema synchronously
  before eager callback invocation.
- [ ] Create a second symbolic root only when compiler metadata declares a
  params slot, and call the transformed callback as `callback(argument,
  params)`.
- [ ] Persist the trusted params schema in the base pattern's internal factory
  state.
- [ ] Carry that trusted schema through the internal Pattern/factory metadata
  used by cold resolution without exposing it as public input schema.
- [ ] Reject an authored second callback parameter that lacks compiler-created
  metadata.
- [ ] Keep the public callback type one-parameter and keep the public
  `PatternFactory` type free of `.curry`.

Expected files/tests:

- `packages/runner/src/builder/pattern.ts`
- `packages/runner/src/builder/factory.ts` and builder helper types
- `packages/runner/test/pattern.test.ts`
- `packages/runner/test/factory-input-types.test.ts`
- a compile-time API test proving authored `.curry` is unavailable

### WP3.2 — Implement the internal one-shot curry derivation

- [ ] Attach `.curry(params)` only to the internal transformed-code view of a
  pattern factory.
- [ ] Require exactly one argument and always bind callback argument 1.
- [ ] During graph construction, validate the complete symbolic params record's
  keys and alias/factory shapes against the trusted schema without prematurely
  materializing reactive captures. Validate concrete values and links again
  when WP3.4 populates the hidden params cell.
- [ ] Return a new branded pattern factory with identical public
  `argumentSchema`/`resultSchema` and canonical hidden `params`.
- [ ] Make `materializeFactory()` reapply canonical params from a decoded bound
  factory, validate them against trusted base metadata, and still reject an
  unbound closure-bearing base. Reconstruct the one-shot bound derivation for
  both direct setup and dynamic dispatch.
- [ ] Preserve the root token/ref and any scope/space derivations regardless of
  modifier order.
- [ ] Throw on a second curry, including an equal/empty value.
- [ ] Throw when the base pattern has no compiler-declared params slot.
- [ ] Never merge, remove, override, or narrow public input fields.
- [ ] Test zero- and two-argument internal curry calls, missing/extra keys,
  wrong concrete values, symbolic Cells/links, second curry, and curry on a
  capture-free pattern.

### WP3.3 — Generalize nested-pattern hoisting

- [ ] Update transformability validation so an inline `pattern(...)` in a
  pattern-owned context is a supported value, not only a `patternTool` or
  `*WithPattern` special case.
- [ ] Collect every non-module lexical capture, including Cells/Reactives and
  all three factory kinds; keep verified module-scoped helpers lexical.
- [ ] Rewrite the hoisted callback to receive public input in argument 0 and a
  deterministically ordered capture record in argument 1.
- [ ] Generate public argument/result schemas plus the private params schema.
- [ ] Wrap the callback with
  `withPatternParamsSchema(callback, paramsSchema)` before passing it to
  `pattern()`; assert there is no fourth `pattern()` argument.
- [ ] Hoist a capture-free base to a deterministic `__cfPattern_N` declaration
  and register it through `__cfReg`.
- [ ] Replace a capturing authored site with exactly
  `__cfPattern_N.curry({ ...captures })`.
- [ ] Replace a capture-free authored site with the bare hoisted factory and no
  curry call.
- [ ] Apply normal cause assignment after the site rewrite.
- [ ] Reject non-portable captured functions and unrepresentable capture
  schemas with source-located diagnostics.
- [ ] Fail closed when an inline wrapper touches a `FrameworkProvided` path
  until WP3.6's trusted forwarding metadata is available; general closure
  conversion must never temporarily permit capture or authored supply.
- [ ] Verify a wrapper around a bound pattern creates a new hoisted wrapper and
  one curry for that wrapper; it must not curry the original twice.

Primary transformer seams:

- `packages/ts-transformers/src/closures/transformer.ts`
- `packages/ts-transformers/src/closures/capture-collector.ts`
- `packages/ts-transformers/src/closures/utils/pattern-builder.ts`
- `packages/ts-transformers/src/transformers/builder-call-hoisting.ts`
- `packages/ts-transformers/src/transformers/schema-injection.ts`
- `packages/ts-transformers/src/transformers/pattern-context-validation.ts`
- `packages/ts-transformers/src/policy/callback-boundary.ts`
- `packages/ts-transformers/src/ast/scope-analysis.ts`
- `packages/ts-transformers/src/core/cross-stage-state.ts`
- `packages/ts-transformers/src/core/context.ts`

Builder hoisting must recognize the generated `pattern(...).curry(captures)`
shape, hoist/register the inner base factory, and preserve the curry at the
authored expression site.

Golden fixtures must cover one/multiple/nested captures, property captures,
Cells, each factory kind, capture-free patterns, name collisions, invalid
functions, deterministic ordering, nested wrappers, JSX/conditional positions,
and an authored second callback argument.

At minimum, add focused `nested-pattern-capture`, capture-free, and
nested-wrapper fixture pairs; extend
`packages/ts-transformers/test/closures/module-scope-helper-hoisting.test.ts`
and the transformer pipeline regression suite.

### WP3.4 — Add the hidden params root and invocation-owned cell

- [ ] Extend the alias vocabulary with `{ $alias: { cell: "params", ... } }`
  without treating `params` as piece input.
- [ ] Give each bound-pattern invocation one immutable hidden params cell with a
  deterministic result-relative cause and `paramsSchema`.
- [ ] Link that cell from result metadata under `params` and link it back to its
  owning result for resume/teardown.
- [ ] Resolve bound params against the parent binding context before writing or
  linking them into the hidden cell.
- [ ] Preserve nested link parents and cross-space links rather than copying
  values across spaces.
- [ ] Update `unwrapOneLevelAndBindToDoc`, `sendValueToBinding`, and direct
  sub-pattern setup to accept the params pseudo-root only when the invocation
  owns a params cell.
- [ ] Populate the same deterministic cell from serialized `Factory@1` state on
  resume before child nodes start.
- [ ] Pre-sync the params cell during reload before graph execution and factor
  the schema-aware projection currently used for argument updates rather than
  applying public-input defaults to params.
- [ ] Tear it down with the owning result and never expose it through public
  argument projection.
- [ ] Define teardown in terms of cancellation, subscription ownership, and
  reachability. If durable owned cells are not physically deleted on ordinary
  stop, prove they cannot be reused or rescheduled by a later generation.
- [ ] Reject invocation of a closure-bearing base factory with absent params.
- [ ] Prove a public field and closure param with the same name remain distinct.
- [ ] Traverse nested factories and preserve CFC labels inside params.
- [ ] Add an A-with-params → B-with-different-params → A dynamic replacement
  test proving a stable output spot, generation-fenced captured writes,
  generation-correct params/CFC labels, and resume of only the active
  generation.

Expected runtime seams/tests:

- `packages/runner/src/sigil-types.ts`
- `packages/runner/src/link-utils.ts`
- `packages/runner/src/pattern-binding.ts`
- `packages/runner/src/result-utils.ts`
- `packages/runner/src/runner.ts`
- result metadata helpers used by `getMetaLink`
- new `packages/runner/test/pattern-closure-params.test.ts`
- `packages/runner/test/pattern-node-alias-schema.test.ts`
- reload/rehydration, `cfc-boundary.test.ts`, and cross-space CFC-focused runner
  tests

### WP3.5 — Unify list callback lowering

- [ ] Change array callback lowering so `map`/`filter`/`flatMap` capture through
  a bound `PatternFactory`, with no sibling params object in newly emitted
  nodes.
- [ ] Make `mapWithPattern`/`filterWithPattern`/`flatMapWithPattern` accept the
  bound factory as the new canonical shape.
- [ ] Make the new canonical node carry only `{ list, op }` and invoke the
  pattern with public `{ element, index, array }`; hidden captures flow only
  through the params root.
- [ ] Keep a dual-read runtime path for stored legacy `{ op, params }` nodes
  during the compatibility window.
- [ ] Keep old public overloads only until source migration and stored-data
  gates pass; mark them deprecated rather than teaching them new semantics.
- [ ] Keep `packages/runner/src/builtins/op-pattern-ref.ts` and
  `packages/runner/src/builtins/list-op-argument-usage.ts` only on the named
  legacy adaptation path; new `Factory@1` nodes go through generic
  materialization.
- [ ] Isolate the legacy branch in `Runner.#substituteOpPatternRefs()` so it
  cannot remain an accidental writer dependency.
- [ ] Update closure-capture diagnostics to recommend inline patterns, not
  manual sibling params.
- [ ] Regenerate affected transformer goldens and test nested map/filter/flatMap
  chains, capture-free callbacks, identity stability, resume, and CFC labels.

Primary files:

- `packages/ts-transformers/src/closures/strategies/array-method-transform.ts`
- `packages/ts-transformers/src/ast/call-kind.ts`
- `packages/runner/src/cell.ts`
- `packages/runner/src/builtins/map.ts`
- `packages/runner/src/builtins/filter.ts`
- `packages/runner/src/builtins/flatmap.ts`
- mirrored overloads in `packages/api/index.ts`

Focused runner coverage includes
`list-builtin-edge-paths.test.ts`, `list-result-schema.test.ts`,
`stored-pattern-rehydration.test.ts`, `pattern-scope.test.ts`, and the map,
filter, and flatMap CFC/identity regression suites. Keep exactly one explicit
legacy `{ op, params }` fixture per builtin; migrate the remaining fixtures to
the one-argument form.

### WP3.6 — Preserve `FrameworkProvided` obligations through wrappers

- [ ] Record trusted framework-provided paths in compiler/artifact metadata for
  each base factory. Do not add them to `FactoryStateV1` or trust paths carried
  by `Factory@1` wire data.
- [ ] When an inline wrapper calls such a factory, synthesize the required
  system fields into the wrapper's argument schema/binding and forward their
  aliases transitively.
- [ ] Keep those fields out of the model-facing tool schema.
- [ ] Inject the value from the wrapper tool instance's stable identity and
  carry that exact value to the ultimate call.
- [ ] Reject an authored literal, capture, or closure param that attempts to
  supply a framework-provided path.
- [ ] Fail closed when a required system value or stable tool identity is
  unavailable.
- [ ] Cover one wrapper, multiple wrappers, a dynamic stored factory, and a
  cross-space invocation.

Expected tests:

- `packages/api/test/framework-provided.test.ts`
- `packages/runner/test/cfc-agent-tool-input-integrity.test.ts`
- `packages/runner/test/sandbox-id-auto-provision.test.ts`
- transformer fixtures for framework-input synthesis and rejection

Replace the hard-coded framework-field handling in
`packages/runner/src/builtins/llm-dialog.ts` only after the generic trusted
metadata path has equivalent fail-closed coverage.

### Stage 3 completion gate

- [ ] Exact emitted IR uses a two-parameter callback,
  `withPatternParamsSchema`, and at most one transformer-only `.curry(params)`.
- [ ] No emitted or runtime path merges closure params into public input.
- [ ] Hidden params cells resume, preserve links/CFC, and tear down with their
  owner.
- [ ] List callbacks emit only bound-factory nodes while old stored nodes still
  read correctly.
- [ ] Framework-provided values remain system-supplied through wrapper chains.
- [ ] Transformer, runner, API, schema-generator, and focused CFC tests pass.

## Stage 4 — Boundary and `patternTool` migration

### WP4.1 — Teach tools and external adapters the new factory value

- [ ] Update `BuiltInLLMTool` in `packages/api/index.ts` to accept a direct
  `PatternFactory` and `{ pattern: PatternFactory, ...metadata }` as canonical
  authored shapes, while retaining the legacy tool object as a deprecated
  compatibility input.
- [ ] Update LLM tool discovery to accept a PatternFactory directly and derive
  the model-facing input from its public `argumentSchema`.
- [ ] Keep optional description/presentation data in an ordinary metadata
  wrapper with a `pattern` field and no `extraParams`.
- [ ] Invoke through the same `materializeFactory`/dynamic path as ordinary
  pattern composition.
- [ ] Update `packages/runner/src/schema-format.ts` and LLM schema formatting to
  understand `asFactory` without subtracting closure params.
- [ ] Update `packages/runner/src/builtins/llm-schemas.ts` and
  `packages/runner/src/builtins/llm-dialog.ts` to write/read the new shape while
  retaining the legacy reader.
- [ ] Preserve `description` and `useResultSchemaForObservation` in the metadata
  wrapper, while sending only reduced `{ description, inputSchema }` data to
  `packages/llm`; factory state never crosses into a provider request.
- [ ] Update `packages/cli/lib/callable.ts` to discover/materialize canonical
  factories and keep legacy `{ pattern, extraParams }` reads.
- [ ] Update `packages/fuse/callables.ts`, `packages/fuse/callable-path.ts`,
  `packages/fuse/tree-builder.ts`, and `packages/fuse/cell-bridge.ts` likewise.
- [ ] Replace FUSE's plain `JSON.stringify`/function-source fallback for factory
  leaves with Fabric codec projection; otherwise callable values would be
  dropped or exposed as source text.
- [ ] Treat callable functions as weak-key-capable discovery values and keep a
  direct pattern factory's `*.tool` projection as a leaf.
- [ ] Decode tagged factory JSON on supported FUSE writes to an inert shell and
  let the runner boundary materialize it.
- [ ] Verify runtime, CLI, and FUSE discover and invoke the same stored factory
  and report the same public input schema.

Focused tests:

- `packages/runner/test/generate-object-tools.test.ts`
- `packages/runner/test/llm-dialog.test.ts`
- `packages/runner/test/schema-format.test.ts`
- CLI callable/integration tests
- `packages/cli/test/exec.test.ts` and the real
  `packages/cli/integration/fuse-exec.sh` flow
- `packages/fuse/callable-path.test.ts`
- `packages/fuse/tree-builder.test.ts`
- `packages/fuse/cell-bridge.test.ts`

### WP4.2 — Install explicit compatibility readers

- [ ] Accept legacy `{ $patternRef, argumentSchema, resultSchema }` wherever a
  pattern factory is expected and adapt it to `FactoryStateV1`.
- [ ] Retain the full surrounding module descriptor when reading legacy
  `$implRef`; do not reinterpret `$implRef` as a factory artifact ref.
- [ ] Accept legacy `{ pattern, extraParams, ...metadata }` tool values and
  preserve their historical merge/precedence rules only in that reader.
- [ ] Accept stored legacy list nodes carrying sibling `{ op, params }`.
- [ ] Make canonical transformed/repository writers emit `Factory@1`, inline
  pattern wrappers, and bound list factories only. Until Stage 5, explicitly
  deprecated public legacy APIs may still produce old shapes for compatibility.
- [ ] Add fixtures for every legacy shape before changing writers.
- [ ] Add diagnostics or counters sufficient to determine whether legacy values
  remain in supported persistent stores; do not log params or other user data.

### WP4.3 — Migrate repository `patternTool` callers

For every caller, replace
`patternTool(searchPattern, { entries })` with an inline `pattern` whose public
input contains only the caller-supplied fields and whose closure invokes the
original pattern with `entries`.

- [ ] Migrate `packages/patterns/cfc-agent-prompt-injection-demo/main.tsx`.
- [ ] Migrate `packages/patterns/deep-research.tsx`.
- [ ] Migrate `packages/patterns/notes/note.tsx`.
- [ ] Migrate `packages/patterns/shopping-list.tsx`.
- [ ] Migrate the affected files under `packages/patterns/system/`, including
  default app, knowledge graph, omnibox, quick capture, space overview,
  suggestion, suggestion history, and summary index.
- [ ] Migrate `packages/cli/integration/pattern/fuse-exec.tsx` and any current
  non-test caller found by the inventory command below.
- [ ] Replace the old structural `PatternToolResult` type in
  `packages/patterns/examples/summary-index-tester.tsx`, if still present when
  this stage begins.
- [ ] Update `packages/patterns/index.md` only where generated summaries or
  public examples change.
- [ ] Update `packages/patterns/test/source-coverage/commonfabric-stub.test.ts`
  so source coverage models the new public API while retaining an explicitly
  named legacy fixture if needed.
- [ ] Verify every wrapper remains readable at the call site and does not expose
  captured values in the public tool schema.
- [ ] Run a final source inventory and classify every remaining hit as API,
  compatibility reader, migration fixture, or historical documentation:

  ```sh
  rg -n "patternTool|PatternToolResult|extraParams" packages docs/common
  ```

### WP4.4 — Stop canonical production of legacy list and tool shapes

- [ ] Remove canonical transformer, internal tool, and repository-source
  construction of `PatternToolResult` and `extraParams`; isolate the deprecated
  public `patternTool` constructor as a named legacy writer until Stage 5.
- [ ] Remove transformer hoisting/callback-boundary special cases that exist
  only to produce `patternTool(pattern(...), extraParams)`.
- [ ] Remove transformer validation messages that recommend `patternTool`.
- [ ] Ensure newly transformed list callbacks cannot emit sibling `params`.
- [ ] Keep separately named, well-tested compatibility readers for old stored
  values; do not leave ambiguous branches in the canonical writer.
- [ ] Add source/fixture assertions that fail if a new canonical writer emits
  `extraParams` or legacy list params.
- [ ] Classify the five transformer `patternTool-*` fixture pairs and the
  patternTool cases in `validation.test.ts`,
  `unknown-capture-validation.test.ts`, `transform.test.ts`,
  `policy/callback-support.test.ts`, and `ast/call-kind-coverage.test.ts`:
  migrate semantic closure cases to inline-pattern coverage and retain only
  explicitly named legacy API/reader cases.

### Stage 4 completion gate

- [ ] A PatternFactory works as an LLM tool directly and inside a metadata
  wrapper.
- [ ] CLI and FUSE discover/materialize/invoke all three serializable factory
  kinds where their callable surfaces permit them.
- [ ] Repository source callers use inline pattern closures, not `patternTool`.
- [ ] Canonical transformer/repository writers emit no `extraParams`, legacy
  `$patternRef` factory value, or sibling list params; deprecated public legacy
  APIs remain isolated and tested until Stage 5.
- [ ] Legacy tool/list/module fixtures still read with their old semantics.
- [ ] Pattern, runner, LLM, CLI, FUSE, transformer, and docs checks pass.

## Stage 5 — Compatibility removal and closeout

Stage 5 is a separately scheduled cleanup. Do not infer that source migration
alone authorizes deleting readers for durable values.

### WP5.1 — Satisfy removal gates

- [ ] Confirm all supported source trees contain no `patternTool` caller.
- [ ] Add a CI/source-inventory assertion with zero `patternTool`,
  `PatternToolResult`, or writer-side `extraParams` hits outside an allowlist of
  compatibility tests and historical docs.
- [ ] Confirm deployed writers have emitted only `Factory@1` for at least the
  agreed compatibility window.
- [ ] Confirm persistent stores have been migrated, expired, or explicitly
  approved for a wipe; record the evidence and decision in this plan.
- [ ] Confirm legacy tool and list reader diagnostics show no supported usage
  for the agreed window.
- [ ] Confirm every supported client/runtime version can read `Factory@1`.
- [ ] Obtain an explicit product/runtime owner decision before deleting a
  durable compatibility reader.

### WP5.2 — Remove legacy APIs and readers

- [ ] Remove `patternTool`, `PatternToolFunction`, and `PatternToolResult` from
  `packages/api/index.ts`, runner builder exports, and trusted builder factory
  wiring.
- [ ] Remove transformer `patternTool` call-kind, boundary, validation, and
  hoisting special cases.
- [ ] Remove LLM/schema-format/CLI/FUSE `extraParams` compatibility branches.
- [ ] Remove legacy list overloads and sibling-params readers.
- [ ] Remove legacy pattern-factory `$patternRef` adaptation only after its own
  stored-data gate passes.
- [ ] Leave module/handler `$implRef` descriptor reconstruction intact unless a
  separately scoped migration proves all of its non-factory users have moved;
  first-class factories alone do not authorize its removal.
- [ ] Remove the runtime's artifact walk
  (`packages/runner/src/encodable-form.ts`) and the `toEncodableForm()` /
  `toJSON()` members it reads only after every Fabric boundary uses registered
  codec dispatch.
- [ ] Keep negative fixtures that prove deleted writers/readers stay deleted.

### WP5.3 — Update live documentation and archive the plan

- [ ] Update `docs/common/README.md` and the relevant pattern composition,
  reactivity, types/schema, LLM, CLI, and FUSE docs for first-class factories.
- [ ] Update live transformer behavior/inventory docs and
  `packages/ts-transformers/docs/array-method-callback-pipeline.md` so they show
  bound factories rather than sibling params.
- [ ] Reconcile `docs/specs/sandboxing/SES_SANDBOXING_SPEC.md`,
  `docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md`,
  `docs/specs/ts-transformer/ts_transformers_type_driven_behavior_inventory.md`,
  `docs/specs/ts-transformer/ts_transformers_design_deltas.md`, and
  `packages/ts-transformers/docs/derive-to-lift-design.md` with the shipped
  closure and factory-call behavior.
- [ ] Update `docs/specs/fuse-filesystem/2-path-scheme.md` and
  `packages/fuse/README.md` for direct factory `.tool` projection and tagged
  factory JSON.
- [ ] Document the author-facing inline-pattern closure model with examples for
  passing, returning, storing, and invoking all factory kinds.
- [ ] Document that `.curry` is not public API and that closure params never
  merge with public input.
- [ ] Update component/pattern examples whose tool construction changed.
- [ ] Reconcile the high-level checklist in
  `docs/specs/pattern-construction/rollout-plan.md`.
- [ ] Mark the source specification implemented if all completion criteria are
  met.
- [ ] Move this completed plan to `docs/history/plans/` with the required
  historical metadata in the final implementation change.

## Risk register

| Risk | Required mitigation |
| --- | --- |
| Internal graph serialization seals before `__cfReg` assigns a ref | Keep live-state traversal separate from durable sealing and test eager construction explicitly. |
| A copied brand or decoded shell gains execution authority | Keep data admission in data-model private tables and executable trust in runner-owned artifact indexes. |
| One Fabric operation still treats a function generically | Add shared factory-state dispatch before function shortcuts in conversion, codec lookup, freeze, clone, equality, hash, and traversal. |
| Factory hashing diverges from codec semantics | Reuse the existing codec-instance byte arm and pin it in the formal hash spec. |
| A replaced dynamic factory writes after cancellation | Fence every async write/result by supervisor generation and test replacement before and after settle. |
| Wire/call-site schemas become authority | Resolve the trusted artifact first and require normalized equality; never elevate hints when trusted schemas are absent. |
| Closure params leak into public input or tool schemas | Maintain separate argument/params roots and assert public-schema snapshots at transformer, runner, LLM, CLI, and FUSE boundaries. |
| Wrapper patterns launder a `FrameworkProvided` value | Synthesize/forward trusted paths and reject authored literals or captures at compile time and runtime. |
| Params resume or teardown follows public-argument lifecycle by accident | Pre-sync the hidden root before execution, avoid public defaults, and define durable-cell ownership separately from physical deletion. |
| FUSE drops callable values or exposes function source | Project factories through the Fabric codec or `.tool` callable view before generic JSON/function handling. |
| Source migration accidentally deletes durable readers | Separate canonical writer removal from evidenced stored-data removal gates and retain named legacy fixtures. |

## Cross-stage validation matrix

### Fabric protocol

- [ ] Encode/decode/hash/equality/clone/freeze every factory kind.
- [ ] Round-trip nested factories, params, Cells/links, scope, and space
  selectors.
- [ ] Reject arbitrary functions, copied symbols, malformed/cyclic states,
  pre-seal state, pseudo refs, kind mismatches, and schema mismatches.
- [ ] Verify independent evaluations of equal factory state hash equally.

### Transformer

- [ ] Golden output shows callback `(argument, params)`, callback-wrapped params
  schema, deterministic hoist, and exactly one internal curry at capturing
  sites.
- [ ] Golden output contains no fourth `pattern()` argument, curry index, input
  merge, or curry at capture-free sites.
- [ ] Symbolic calls lower for aliases/properties/elements and direct live calls
  remain direct.
- [ ] List callbacks use bound factories with no sibling params writer.
- [ ] Diagnostics cover invalid captures, authored callback argument 1, second
  curry, missing params, untransformable symbolic calls, and bad unions.

### Runtime

- [ ] Warm and cold invoke stored pattern, module, and handler factories.
- [ ] Replacing a factory-valued cell cancels/fences/tears down the prior
  generation while retaining the output spot.
- [ ] Hidden params cells preserve same-named public fields, nested aliases,
  cross-space links, resume, teardown, and CFC labels.
- [ ] Captured factories can themselves be stored and invoked.
- [ ] Schema-light `byRef()` resolves only through trusted registry metadata.
- [ ] Forged refs/metadata fail closed.

### Boundaries and migration

- [ ] JSON, memory client/server, Cell/query, piece, cross-space, CLI, FUSE, and
  LLM tool paths preserve canonical factory state and callability after runner
  materialization.
- [ ] Framework-provided inputs remain hidden from the model and cannot be
  authored/captured.
- [ ] Legacy tool and list fixtures read until their explicit removal gates.
- [ ] No canonical writer emits `extraParams` or sibling list params.

## Final command checklist

Use the package's current task names if they change while this live plan is in
progress.

- [ ] `deno task test` in `packages/data-model`
- [ ] `deno task test` in `packages/schema-generator`
- [ ] `deno task test` in `packages/ts-transformers`
- [ ] `deno task test` in `packages/runner`
- [ ] `deno task test` in `packages/llm`
- [ ] `deno task test` in `packages/cli`
- [ ] `deno task test` in `packages/fuse`
- [ ] Root `deno task check`
- [ ] Focused API type tests, including the negative public `.curry` assertion
- [ ] A representative `deno task cf check ... --show-transformed --no-run`
  output inspected for closure and symbolic-call IR
- [ ] Fresh-runtime cold round-trip integration for all three factory kinds
- [ ] `deno task check-docs specs/pattern-construction`
- [ ] `deno task check-docs plans`
- [ ] `git diff --check`

## Overall completion criteria

- [ ] Every content-addressed pattern/module/handler factory round-trips as a
  directly callable-after-materialization `Factory@1`; non-resolvable
  factories fail durable encoding.
- [ ] Arbitrary JavaScript functions remain invalid `FabricValue`s.
- [ ] Factory-valued inputs, outputs, stored values, and captures invoke through
  one dynamic runner path.
- [ ] Nested patterns preserve lexical semantics through callback argument 1
  and exactly one transformer-only `.curry(params)` per wrapper layer.
- [ ] Public pattern input and closure params are never merged.
- [ ] Refs, schemas, params, scope, space selection, CFC labels, equality, and
  hashes survive storage and cold reload.
- [ ] `patternTool` and sibling list params have no writer/source path, and all
  retained compatibility readers have explicit, evidenced removal gates.
