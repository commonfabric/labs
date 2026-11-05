---
status: historical
created: 2026-07-10
archived: 2026-07-12
reason: "Executed plan; first-class serializable factories shipped through pre-launch compatibility cleanup."
---

# First-Class Serializable Factories — Implementation Plan

Status: Complete

This plan implements
[First-Class Serializable Factories](../../specs/pattern-construction/node-factory-shipping.md).
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

- [x] Use one directly branded callable `Factory@1` value for pattern, module,
  and handler factories; do not introduce `FabricPatternFactory`,
  `FabricModuleFactory`, or another wrapper object.
- [x] Keep the factory artifact ref distinct from `$implRef`; only the complete
  content-addressed builder artifact can back durable factory state.
- [x] Decode to a branded, inert callable shell. Only runner-owned
  `materializeFactory` may turn a shell into an executable builder factory.
- [x] Keep public pattern input in callback argument 0 and closure params in
  callback argument 1. Never merge the two records.
- [x] Carry the compiler-generated params schema with
  `withPatternParamsSchema(callback, schema)` before `pattern()` eagerly invokes
  the callback; do not add a fourth `pattern()` argument.
- [x] Emit `.curry(params)` only from the transformer, with exactly one
  argument, no argument index, and a hard error on a second call.
- [x] Permit durable encoding only when the root artifact has a cold-resolvable
  content-addressed `{ identity, symbol }` ref. Reject keyless, action-created,
  and host-pseudo-module factories.
- [x] Keep the dynamic call site's output spot as the stable identity anchor
  when the selected factory changes.
- [x] In an eager pattern callback, keep a factory-valued input/capture as a
  symbolic Cell/link binding. Serialize that binding in the dynamic node;
  never snapshot the currently selected factory ref into the graph.
- [x] Before invoking a `lift` implementation or handler event, materialize
  each `asFactory` argument as the current ordinary callable. Never expose an
  inert shell, promise, or lazy executable wrapper to authored callback code.
- [x] Make cold readiness local to the consuming dynamic node, lift attempt, or
  handler event. Whole-parent preloading is cache-only; only a cold root passed
  to non-transactional Promise-based `setup(undefined, ...)` intrinsically
  gates parent setup. `run()` and transaction-bound setup remain warm-only.
- [x] Keep artifact source space as trusted runner provenance, distinct from a
  pattern factory's serialized `spaceSelector` execution target. Do not add
  source authority to `Factory@1`.
- [x] Read the selected factory in the consuming action/event transaction and
  reread it after a cold await so reactive dependencies and CFC provenance
  describe the value that actually executes.
- [x] Preserve `FrameworkProvided` inputs as system-supplied inputs through
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

- [x] Compare each reference commit against current `main`; record which hunks
  are already present and which semantic tests still fail.
- [x] Copy or reimplement only changes touching generic pattern-value binding,
  executable lookup, and direct setup/sub-pattern resolution.
- [x] Explicitly exclude reactive-interpreter dispatch, strict-interpreter-only
  rewrites, or unrelated runner refactors from the port.
- [x] Keep current runner behavior outside the new `$patternRef` cases byte-for-
  byte or test-for-test equivalent.
- [x] Record the API discrepancy from the reference work: current `run()` is
  synchronous and cannot perform storage-backed cold loading without an API
  redesign. Preserve that API and put the cold fallback on Promise-based
  non-transactional `setup()`.

Expected implementation files:

- `packages/runner/src/pattern-binding.ts`
- `packages/runner/src/runner.ts`
- `packages/runner/src/builtins/op-pattern-ref.ts`
- `packages/runner/src/harness/executable-registry.ts` only if the current
  executable lookup still needs the generic artifact path

Audit record (2026-07-11):

- None of `3b028c786`, `39b213e63`, or `ede6c5a7d` is an ancestor of this
  branch.
- Current `main` already had the schema-carrying `PatternRefSentinel`, warm and
  async stored-pattern resolvers, generic trusted artifact indexing, and the
  canonical schema-carrying `patternToJSON()` form. It lacked the generic
  binding conversion and direct sentinel setup/sub-pattern resolution covered
  here.
- `Runner.substituteOpPatternRefs()` remains because the newer keyless list
  path and `keyless-op-identity.test.ts` still depend on it. The reference
  deletion was not reproduced, and no executable-registry change was needed.
- The reactive-interpreter dispatch/refactors from #4514 were excluded. The
  only API discrepancy is the documented warm synchronous `run()` versus cold
  asynchronous non-transactional `setup()` split.
- Validation before completion: the focused six-file matrix passed with
  `8 passed (48 steps), 0 failed`; the complete runner package task passed with
  `870 passed (4686 steps), 0 failed, 0 ignored (10 steps)`.

### WP0.2 — Bind nested pattern values by reference

- [x] Add a red test showing an addressable pattern nested in an object/array
  binding is replaced with a `$patternRef` sentinel rather than copied as an
  inert graph.
- [x] Preserve `argumentSchema` and `resultSchema` on the sentinel.
- [x] Preserve derivation provenance so a serialized copy still resolves its
  root artifact ref after registration.
- [x] Cover direct, nested, repeated, and aliased occurrences without changing
  ordinary object traversal.
- [x] Preserve the current legacy graph fallback for a keyless pattern; the new
  durable `Factory@1` identity rejection belongs to Stage 1, not this
  prerequisite port.

Tests to port or extend:

- `packages/runner/test/pattern-binding.test.ts`
- `packages/runner/test/pattern-node-patternref.test.ts` (new if still absent)

### WP0.3 — Resolve a sentinel passed directly to setup/run

- [x] Add a red test for a `$patternRef` handed directly to sub-pattern setup,
  not only nested inside another binding.
- [x] Resolve synchronously from the artifact index in both `run()` and
  `setup()` when warm.
- [x] In `setup(undefined, ...)`, fall back to the existing storage-backed
  identity loader when cold, then re-enter the same sentinel validation path.
- [x] Keep synchronous `run()` and transaction-bound setup warm-only. A cold
  ref fails clearly without partially mutating or starting the piece; do not
  change `run()`'s return type.
- [x] Validate the resolved value is a trusted pattern with matching schemas.
- [x] Ensure a missing or wrong-kind ref fails closed and includes identity and
  symbol in the diagnostic.

Tests to port or extend:

- `packages/runner/test/pattern-tool-invoke-boundary.test.ts`
- `packages/runner/test/pattern-ref-boundary.test.ts`
- `packages/runner/test/stored-pattern-rehydration.test.ts`

### Stage 0 completion gate

- [x] The three reference commits are not ancestors of this work by accident;
  only reviewed prerequisite behavior has been reproduced.
- [x] `deno test` passes for the focused Stage 0 runner tests.
- [x] `deno task test` passes in `packages/runner`.
- [x] No Stage 0 code depends on reactive-interpreter-only types or flags.
- [x] No async `run()` API or hidden fire-and-forget cold load was introduced.
- [x] Commit the stage as a standalone, revertible prerequisite.

## Stage 1 — Branded callable Fabric values

### WP1.1 — Define the dependency-light factory protocol

- [x] Add the `FabricFactory` callable arm to
  `packages/data-model/src/interface.ts` and mirror it in
  `packages/api/index.ts`.
- [x] Define the `FactoryStateV1` discriminated union with exactly the fields in
  the specification: shared `ref`; pattern schemas/params/scope/space selector;
  module schemas/scope; and handler context/event schemas.
- [x] Add internal live-state support with a stable root token and an optional,
  not-yet-sealed ref. Keep live state out of the public wire type.
- [x] Add one module-private admission/state table and shared
  `tryFactoryState()` / `factoryStateOf()` access path. A copied symbol property
  must not pass admission.
- [x] Provide an internal registration API for trusted builder constructors and
  codec-created shells without granting runner execution trust.
- [x] Keep all properties used for branding/state access non-enumerable and do
  not modify `Function` or `Function.prototype`.
- [x] Export only the minimum protocol surface needed by the runner and codec;
  do not expose `.curry` or state mutation to pattern authors.
- [x] Re-export the runner-facing protocol through
  `packages/data-model/src/fabric-value.ts` without creating a dependency from
  the data model back into the runner.

Expected implementation files:

- `packages/data-model/src/interface.ts`
- a new dependency-light module such as
  `packages/data-model/src/fabric-factory.ts`
- `packages/data-model/deno.jsonc` export map
- `packages/api/index.ts`

### WP1.2 — Add `Factory@1` codec dispatch

- [x] Add the `Factory@1` constant to
  `packages/data-model/src/codec-common/codec-type-tags.ts`.
- [x] Implement a `FactoryCodec` with wire tag `Factory@1`.
- [x] Validate discriminant, exact allowed fields, content-addressed ref shape,
  schemas, modifiers, and pattern-only params fields during decode.
- [x] Decode to a frozen branded callable shell whose body throws
  `factory requires runner materialization` and whose state can be re-encoded.
- [x] Add a dedicated callable-factory codec slot to
  `packages/data-model/src/codec-json/CodecRegistry.ts`; do not classify all
  functions as primitives or match `Function` by constructor.
- [x] Register the codec in
  `packages/data-model/src/codec-json/createDefaultRegistry.ts`.
- [x] Route callable factories through codec lookup before generic function
  rejection in JSON serialization. Native conversion's ordering before legacy
  function `toJSON()` remains part of WP1.3.
- [x] Include callable factories in JSON encoder cycle tracking.
- [x] Reject arbitrary functions, copied brand symbols, malformed state,
  unknown kinds, extra fields, and cyclic state.

Expected implementation and test files:

- `packages/data-model/src/codec-common/` for the codec/state validator
- `packages/data-model/src/codec-json/CodecRegistry.ts`
- `packages/data-model/src/codec-json/JsonEncodingContext.ts`
- `packages/data-model/src/codec-json/createDefaultRegistry.ts`
- `packages/data-model/src/codec-json/json-encoding.ts`
- `packages/data-model/test/codec-common/FactoryCodec.test.ts`
- `packages/data-model/test/codec-json/CodecRegistry.test.ts`
- `packages/data-model/test/codec-json/JsonEncodingContext.test.ts`
- `packages/data-model/test/codec-json/json-encoding.test.ts`
- a focused `packages/data-model/test/fabric-factory.test.ts`

### WP1.3 — Make every Fabric operation see the same factory state

- [x] Update `packages/data-model/src/native-conversion.ts` so admitted
  factories are recognized before legacy function `toJSON()` and unbranded
  functions remain invalid. Classification uses the admission-only predicate
  rather than `tryFactoryState()` so it cannot execute a live state accessor;
  codec dispatch remains the serialization layer's job.
- [x] Update `packages/data-model/src/type-check.ts` and compatibility guards so
  `FabricFactory` is the only valid function-shaped Fabric value.
- [x] Update `packages/data-model/src/deep-freeze.ts` to seal/freeze canonical
  state and then freeze the callable. Factory handling must precede the current
  shortcut that treats functions as already frozen.
- [x] Update `packages/data-model/src/value-clone.ts` so canonical factories are
  immutable logical atoms and both mutable/frozen clone requests preserve the
  same canonical factory.
- [x] Update `packages/data-model/src/valueEqual.ts` to compare canonical codec
  state rather than function identity, before any same-reference shortcut that
  could accidentally admit an arbitrary function.
- [x] Update `packages/data-model/src/value-hash.ts` to hash the `Factory@1` tag
  and recursively hashed canonical state.
- [x] Ensure the native conversion, type/compatibility, codec, and deep-freeze
  paths use shared admission/state helpers rather than independently
  enumerating hidden fields.
- [x] Extend that shared-helper invariant to clone, equality, and hash.
- [x] Make encode and Fabric deep-freeze fail before a live factory's artifact
  ref can be sealed.
- [x] Make hash and equality fail before that artifact ref can be sealed.
- [x] Verify sealing memoizes one immutable canonical state.
- [x] Verify the canonical state produces a stable hash.

Focused tests:

- `packages/data-model/test/native-conversion.test.ts`
- `packages/data-model/test/type-check.test.ts`
- `packages/data-model/test/deep-freeze.test.ts`
- `packages/data-model/test/cloneIfNecessary.test.ts`
- `packages/data-model/test/cloneForMutation.test.ts`
- `packages/data-model/test/shallowMutableClone.test.ts`
- `packages/data-model/test/value-clone.test.ts`
- `packages/data-model/test/valueEquals.test.ts`
- `packages/data-model/test/value-hash.test.ts`

Each suite must cover all three factory kinds, nested factory state, independent
but equal decoded shells, pre-seal failure, and arbitrary-function rejection.

### WP1.4 — Attach canonical state in runner builders

- [x] Brand the function returned by `pattern()` in
  `packages/runner/src/builder/pattern.ts` as kind `pattern`.
- [x] Brand functions returned by `createNodeFactory()`, including `lift()`,
  `byRef()`, raw/builtin factories, and equivalent helpers, as kind `module`.
- [x] Brand `handler()` results as kind `handler` while retaining separate
  `contextSchema` and `eventSchema` before the internal `$ctx`/`$event` schema
  combination.
- [x] Populate state from the complete builder descriptor, never from
  `moduleToJSON(...).$implRef`.
- [x] Reuse or generalize the derivation/root tracking in
  `packages/runner/src/builder/pattern-metadata.ts` so `asScope()`, `inSpace()`,
  later `.curry()`, and traversal copies share one root token and late ref.
- [x] Make `asScope()` and every `inSpace()` selector form create a new branded
  factory whose canonical state includes the modifier without resolving a raw
  selector prematurely.
- [x] Seal through the root token's durable artifact-ref lookup only after
  `PatternManager` indexes an export or `__cfReg` artifact whose source closure
  was persisted in, or verified-loaded from, a concrete artifact space.
- [x] Make that cold-resolvable artifact association feed the root token's
  late-ref state so a derived factory created before registration seals against
  the same canonical artifact without introducing a data-model-to-runner
  dependency.
- [x] Reject durable encoding of keyless/manual, action-created, and `host:<n>`
  pseudo-module factories.
- [x] Preserve existing direct live invocation behavior before and after state
  attachment.

Implementation note: the existing `setArtifactEntryRef()` is also used for
session-only manual, keyless, action-created, and `host:<n>` identities. Bare
evaluation and `compileAndRegisterModules()` likewise establish only a verified
in-memory index; they do not persist a closure for cold reconstruction. Feeding
either channel into durable factory state would contradict the rejection
requirement above. WP1.4 therefore adds a distinct storage-durable association
path used only after an awaited cache write or a verified storage-backed load.
The legacy setter and ordinary evaluated-module registration remain
compatibility/session lookups and cannot unlock `Factory@1` sealing.

Focused tests:

- `packages/runner/test/factory-input-types.test.ts`
- `packages/runner/test/pattern-provenance.test.ts`
- `packages/runner/test/pattern-scope.test.ts`
- `packages/runner/test/host-pseudo-module.test.ts`
- new `packages/runner/test/factory-state.test.ts`

### WP1.5 — Traverse hidden factory state during graph construction

- [x] Adapt the shared visitor/accessor from
  `packages/data-model/src/fabric-factory.ts` for builder traversal; runner code
  supplies alias mapping and derived-callable construction but does not define
  a second state view.
- [x] Integrate it into `packages/runner/src/builder/traverse-utils.ts` and
  `packages/runner/src/builder/json-utils.ts` before generic function handling.
- [x] Preserve live, pre-ref factory state during internal graph serialization;
  sealing belongs at a later durable Fabric boundary, after artifact indexing.
- [x] Convert captured Cells/Reactives to aliases inside factory state.
- [x] Descend into nested factories without exposing enumerable `curried` or
  state fields.
- [x] Keep CFC inspection and alias traversal on the same logical state view as
  serialization, hashing, and equality.
- [x] Verify two references to the same factory do not cause false cycle errors,
  while an actual cycle through params is rejected.
- [x] Review graph payload fields in `packages/runner/src/builder/types.ts` and
  static-data walks in `packages/runner/src/cell.ts` so hidden factory state is
  neither flattened nor skipped.
- [x] Route `createRef()` identity derivation and action writable/scheduler-read
  collection through the same hidden-state visitor. Keep Fabric-special values
  atomic, make occurrence-sensitive schema/path visits repeat safely, reject
  real hidden-state cycles and arbitrary nested functions, and retain only the
  explicit keyless pattern-graph implementation fallback.
- [x] Verify `packages/runner/src/storage/differential.ts`,
  `packages/runner/src/storage/v2-transaction.ts`, and
  `packages/memory/v2/patch.ts` treat factories atomically through the shared
  equality/clone protocol.
- [x] Keep native type inspection at the proxy meta-object boundary: it must
  obtain constructor identity from prototype metadata rather than reading an
  inherited `constructor` through a live query proxy and misclassifying the
  host `Object` constructor as authored Fabric data.
- [x] Add one shared data-URI decoder that dispatches only by exact media type:
  legacy `application/json` remains ordinary JSON, while
  `application/vnd.commonfabric.fabric-value` requires a versioned `fvj1:`
  payload and decodes context-free to inert shells. Add the pure canonical
  Fabric-value URI encoder at the same seam without flipping repository
  writers yet.
- [x] Make the shared `createDataCellURI()` boundary emit the canonical Fabric
  document, map relative links through hidden factory state, preserve
  Fabric-special atoms, and require a runner-supplied artifact-space
  availability proof before encoding any nested factory. Make data-URI
  inlining traverse the same hidden state without materializing decoded
  shells.
- [x] Track storage-durable artifact availability by exact
  `(artifactSpace, identity)` runner provenance. Record it only after awaited
  source persistence or a verified storage-backed source closure, recursively
  including pinned Fabric-import roots; warm evaluation, requested-space
  lookup, and compiled-only caches do not grant writer authority.
- [x] Migrate every data-URI reader to the shared dual-format decoder before
  the canonical writer changes, retaining percent/base64 UTF-8 compatibility
  and literal legacy slash-key objects without payload sniffing.
- [x] Route the storage attestation loader through that shared decoder while
  preserving its invalid-vs-unsupported error taxonomy and legacy empty
  payload rejection; base64 input is decoded as UTF-8 for both formats.
- [x] Flip canonical durable inline-document writers to the Fabric-value MIME
  only after every nested factory is proven available in the exact containing
  artifact space; a synchronous writer rejects otherwise.
- [x] Once canonical factory traversal is available, switch durable
  factory-valued binding from Stage 0's `$patternRef` sentinel to `Factory@1`.
  Constrain `$patternRef` emission to explicitly legacy/internal graph fallback
  paths and add a test that new durable factory writes cannot choose it.
  Until that switch, explicit root pattern graph serialization remains an
  internal helper; within node payload serialization, a pattern node's
  `module.implementation` remains an explicit graph fallback. The obsolete
  builder-time list-`op` graph conversion is removed: an admitted list op stays
  callable through graph construction, and only Runner's named
  `map`/`filter`/`flatMap` compatibility adapter replaces the unmodified base op
  with `$patternRef` at instantiation. Stage 4 removes that named sentinel
  writer; arbitrary factory-valued graph data already stays callable.
  The keyless list regression now observes the actual transformer-generated
  `op` callable; its former association with a nested exported wrapper was a
  derivation artifact of the removed embedded-graph path.
  The in-memory binding walks now preserve admitted factories and traverse
  their hidden state without emitting `$patternRef`. The named list adapter is
  intentionally limited to a capture-free, unmodified base pattern so it
  cannot discard params, scope, or space-selection state. The canonical durable
  data-URI writer now emits `Factory@1`, closing this gate; the named list
  sentinel remains the explicit Stage 4 compatibility writer.

### WP1.6 — Add runner-owned factory materialization and generic resolution

- [x] Generalize `PatternManager.loadPatternByIdentity()` into, or layer it on,
  a generic source-space-aware
  `loadArtifactByIdentity(identity, symbol, artifactSpace)` path that returns
  only trusted indexed builder artifacts.
- [x] Preserve warm artifact-index lookup, storage-backed cold loading,
  single-flight behavior keyed by source space plus identity, `__cfReg` symbol
  resolution, and CFC verification.
- [x] Keep a pattern-specific wrapper temporarily for existing callers.
- [x] Implement the runner chokepoint with an explicit trusted context carrying
  runtime, artifact source space, expected kind/schemas, and optional
  owner/generation. Provide a warm synchronous materializer and an async-ready
  cold form rather than weakening one return type.
- [x] Return live factories unchanged when their trusted kind/state already
  match.
- [x] For decoded shells, resolve the trusted base artifact, compare kind and
  normalized schemas, reapply scope/space modifiers, retain canonical codec
  state, and return a callable builder factory.
- [x] Keep schema-light module factories unresolved until a trusted
  `ModuleRegistry` entry supplies schemas; never promote wire or call-site
  hints to execution authority.
- [x] Keep artifact loading space distinct from a pattern factory's
  `spaceSelector`; apply the latter only after trusted base resolution as the
  child execution target.
- [x] Fence async materialization by owner/selection generation and require
  callers to reread reactive selection after an await. A completed load may
  warm a cache but must not authorize a stale factory to execute.
- [x] Until Stage 3 lands, fail materialization closed for decoded pattern state
  containing `paramsSchema` or `params`; Stage 1 may validate and re-encode that
  state but cannot yet reconstruct its runtime binding semantics.
- [x] Reject missing refs, wrong kinds, schema mismatches, forged metadata, and
  non-factory values with stable diagnostics.

Expected files and tests:

- `packages/runner/src/pattern-manager.ts`
- a focused runner module such as
  `packages/runner/src/factory-materialization.ts`
- `packages/runner/test/pattern-manager.test.ts`
- `packages/runner/test/fabric-imports-pattern-manager.test.ts`
- new `packages/runner/test/factory-materialization.test.ts`

### WP1.7 — Prove context-free and runner-aware round trips

- [x] Add an awaited `ensureArtifactClosureInSpace(identity, source,
  destination)` primitive that copies or verifies the complete source and
  compiled closure, including Fabric-import dependencies, before a by-value
  writer commits in another space. This implementation item is explicit here
  because the original proof-only wording below otherwise had no writer seam
  capable of satisfying it.
- [x] Round-trip pattern, module, and handler factories through context-free
  JSON and confirm decode returns inert callable shells.
- [x] Re-encode each shell without a runner and get identical canonical state.
- [x] Materialize each shell in a warm runner and invoke it through its existing
  direct path.
- [x] Cold-load each kind in a fresh runtime from the content-addressed module
  identity and the correct artifact source space.
- [x] Round-trip factories nested in plain arrays/objects and synthetic decoded
  factory state. Typed Cell/piece coverage waits for Stage 2 `asFactory`, and
  live bound-pattern params wait for Stage 3's internal curry and params root.
- [x] Preserve `asScope()` and named, anonymous, and cell-derived `inSpace()`
  selectors across the round trip.
- [x] Prove artifact source space and `inSpace()` execution target may differ,
  including a cross-space link and a by-value copy whose writer durably
  replicated the artifact closure into the containing destination space before
  committing the Factory value.
- [x] Verify equal state hashes equally across independent verified module
  evaluations.

### WP1.8 — Update the live Fabric protocol documentation

- [x] Update `docs/specs/space-model-formal-spec/1-fabric-values.md` when the
  callable Fabric arm lands.
- [x] Update `docs/specs/space-model-formal-spec/3-json-encoding.md` with the
  exact `Factory@1` tag, validated state, and inert context-free decode.
- [x] Pin `Factory@1` to the existing codec-instance byte arm in
  `docs/specs/space-model-formal-spec/2-hash-byte-format.md`; do not invent a
  factory-specific hash encoding.
- [x] Keep the proposal's status accurate for the still-unimplemented dynamic
  invocation and closure stages.

### Stage 1 completion gate

- [x] `Factory@1` is the only new wire tag and no wrapper factory type exists.
- [x] All three trusted factory constructors attach state and direct invocation
  remains green.
- [x] Arbitrary functions and pseudo refs are still rejected.
- [x] Context-free decode is inert; runner materialization is the only path to
  executable behavior.
- [x] `deno task test` passes in `packages/data-model` and `packages/runner`.
- [x] `deno check packages/api/index.ts` (or the package's standard type-check)
  passes with `.curry` absent from public `PatternFactory`.
- [x] Commit Stage 1 in protocol, builder-state, and materialization slices.

Stage 1 full-runner gate audit (2026-07-11): the complete task ran to
`868 passed (4635 steps), 24 failed (124 steps)`. Every representative failure
was green at the branch merge-base and was traced to a deliberate new boundary:
deprecated keyless `patternTool` payloads reached the durable Factory writer,
other ephemeral built-in constants reached the canonical inline writer, and
traverse replay goldens retained legacy data-URI identities. The explicit
`patternTool` structural compatibility writer is now restored without weakening
ordinary keyless-factory rejection, and its sandbox suite is green. The package
gate remains unchecked until the remaining Stage 2/4 migrations land and the
logically-equivalent replay goldens are regenerated; it is not waived.

## Stage 2 — Factory schemas and symbolic invocation

### WP2.1 — Add `asFactory` to the public schema vocabulary

- [x] Extend `JSONSchemaObj` in `packages/api/index.ts` with a discriminated
  `asFactory` definition for `pattern`, `module`, and `handler`.
- [x] Use `argumentSchema`/`resultSchema` for pattern and module kinds and
  `contextSchema`/`eventSchema` for handler kind.
- [x] Document and test the two execution-context exposures of the one schema
  form: an eager pattern root produces a symbolic binding, while a scheduled
  `lift`/handler argument is runner-materialized to a live callable. API typing
  alone must not make a symbolic proxy executable.
- [x] Define one schema normalization/equality helper for trusted factory
  comparisons; version 1 requires equality, not variance.
- [x] Update schema validation/resolution utilities that copy, merge, sanitize,
  or format Common Fabric extensions so `asFactory` is preserved.
- [x] Teach `Schema<T>` / `SchemaWithoutCell<T>` in
  `packages/api/schema.ts` to materialize `asFactory` as the matching generic
  `PatternFactory`, `ModuleFactory`, or `HandlerFactory`.
- [x] Ensure `asFactory` composes correctly with refs/definitions and does not
  silently become `asCell`.
- [x] Add public type assertions in `packages/api/test/factory-input-types.test.ts`
  and `packages/api/index.test.ts` proving factories are Fabric values, schema
  inference preserves their generics, and `.curry` is unavailable.

Type-system audit: embedding three recursively complete `JSONSchema` branches
inside `JSONSchemaObj.asFactory` and recursively re-entering `SchemaInner`
caused checked runner files to exceed V8's 4 GB heap. The public field therefore
uses a JSON-shaped `EmbeddedFactorySchema` boundary (concrete literals retain
their exact schema type), and inference carries a one-boundary factory budget.
This keeps ordinary nested containers fully typed and allows a factory schema
at any such leaf without making broad `Schema<JSONSchema>` instantiations
exponential. Runtime normalization and materialization still validate and
compare the complete recursive schema document exactly.

### WP2.2 — Generate schemas for all factory kinds

- [x] Teach `packages/schema-generator/src/formatters/object-formatter.ts` to
  recognize `PatternFactory`, `ModuleFactory`, and `HandlerFactory` before its
  generic callable and callable-return-wrapper cases.
- [x] Prefer one dedicated factory detector/formatter, registered before union,
  intersection, and object formatting, so aliases and branded intersections
  cannot fall through to generic callable handling.
- [x] Extract public input/output schemas from the factory type arguments.
- [x] Ensure `HandlerFactory` emits `contextSchema`/`eventSchema` and is not
  mistaken for `{ asCell: ["stream"] }` merely because its call signature
  returns a stream.
- [x] Preserve schemas for aliases, properties, arrays/maps of factories, and
  factory unions used only as stored/returned values, using `anyOf` or the
  schema generator's equivalent union representation.
- [x] Keep storage representability separate from callability: cross-kind or
  schema-varying unions are rejected only when WP2.3 tries to invoke them.
- [x] Add fixtures covering factory-valued inputs, outputs, captures, nested
  containers, `byRef()`, and all three kinds.

WP2.2 audit discrepancy: the existing Common Fabric callable-wrapper formatter
claimed a union containing `HandlerFactory` before `UnionFormatter` could retain
its stored union shape, because the handler call signature returns `Stream`.
Registering the dedicated factory formatter first was therefore insufficient on
its own. The callable-wrapper path now explicitly declines factory-containing
unions, leaving them to ordinary union storage formatting; invocation-time
cross-kind/schema compatibility remains WP2.3's responsibility.

Expected tests:

- a new `packages/schema-generator/test/schema/factory-types.test.ts`
- paired fixtures under `packages/schema-generator/test/fixtures/schema/`
- `packages/schema-generator/test/schema/factory-input-real-api.test.ts`
- `packages/schema-generator/test/fixtures-runner.test.ts`

### WP2.3 — Lower symbolic factory calls

- [x] Add a type-directed callee classifier in `packages/ts-transformers` that
  distinguishes live imported/module-scoped factories, eager symbolic/reactive
  factory bindings, and runtime-materialized callback arguments.
- [x] Follow local aliases, property access, and statically typed element access
  such as `const f = inputs.operation; f(x)` and
  `inputs.operations[key](x)`.
- [x] Leave calls to live imported or module-scoped factories on the direct
  builder call path.
- [x] Lower factory calls originating from eager pattern argument/params roots,
  including captures used inside nested authored callbacks. Leave calls on
  `asFactory` parameters inside `lift` implementations and handler
  context/event callbacks direct; the runner prepares those arguments first.
- [x] Lower symbolic calls to internal `__cfHelpers.invokeFactory(factory,
  input, expectedSchema)`.
- [x] Emit a pattern/module result as `Reactive` and a handler result as
  `Stream`, preserving handler `$ctx`/`$event` wiring.
- [x] Reject a cross-kind union before graph construction and require normalized
  schema agreement for same-kind unions.
- [x] Add a compile-time diagnostic for an untransformed symbolic factory proxy
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
union, and schema mismatch. Add paired `lift` parameter, handler-context, and
handler-event fixtures proving those runtime calls remain direct while their
schemas carry `asFactory`; extend pipeline regression coverage so later passes
cannot undo either classification.

Stage 1 transformed-output audit discrepancy: exporting
`baseFactory.asScope(...).inSpace(...)` or `lift(...).asScope(...)` is currently
wrapped in `__cf_data(...)`, so the sandbox correctly rejects the derived
callable as non-plain data. The Stage 1 round-trip proof therefore derives
modifiers from an already verified base artifact. WP2.3 must add a focused red
fixture and classify these live factory-modifier chains as direct factory
values; do not weaken the plain-data sandbox to accept arbitrary functions.

WP2.3 execution-context audit: factory exposure is decided by the nearest
materializing or eager boundary, not permanently by the declaration site. A
factory captured from an eager root into `computed`/`lift` is direct after the
runner-materialized scheduled boundary; transparent nested array callbacks do
not hide that boundary. Conversely, a factory parameter delivered live to a
lift becomes symbolic again when captured by a nested eager `pattern()`
callback. The early lowering now records that symbolic call; WP2.6 still owns
rewriting the capture itself onto callback argument 1. `HandlerState<T>` also
preserves `FabricFactory` call signatures instead of recursively mapping them
to readonly data objects, so handler context delivery has the same direct-call
typing as lift delivery.

WP2.3 compatibility audit: broadening structural-call recognition for public
module/handler factories initially suppressed the existing `.for(...)` cause
assignment for internal and legacy node factories. The final classifier keeps
that established pattern-shaped path and uses branded Factory@1 detection only
for the new public kinds. Canonical `asFactory` output replaced two legacy
handler-as-stream transformer goldens. Live `.asScope()`/`inSpace()` derivations
are carried through a cross-stage marker so the late module-data pass does not
wrap callable factories in `__cf_data`. Symbolic tuple/rest spread is rejected
with a source diagnostic because spreading would require synchronously reading
reactive graph input and would otherwise shift the helper contract argument.

WP2.3 validation: the new origin/scheduled-context/diagnostic suites, a
multi-file imported-factory regression, schema-light `byRef()` and all-kind
goldens, modifier-chain golden, and pipeline regression are green. Complete
`packages/ts-transformers` task: `1041 passed (737 steps), 0 failed`; complete
`packages/schema-generator` task: `28 passed (248 steps), 0 failed`; complete
`packages/api` task: `16 passed, 0 failed` (with explicit API type-check also
green). Representative transformed output was inspected directly for both
symbolic and scheduled/direct factory calls.

### WP2.4 — Build the internal dynamic factory node

- [x] Implement `invokeFactory` in the runner builder layer so it records a
  dynamic node whose module input is the symbolic factory binding and whose
  call input and expected kind/public schemas are explicit. Never snapshot the
  selected factory ref into the serialized node or its cause.
- [x] Extend `NodeRef.module`/serialized node typing only as narrowly as needed;
  do not add another public factory wrapper.
- [x] Complete the dynamic-module arm currently marked `TODO` in
  `packages/runner/src/runner.ts`.
- [x] Subscribe to the factory binding before its first value. Initial absence
  leaves the node pending with no child and later arrival instantiates it.
- [x] Resolve the factory cell value through `materializeFactory`, validate kind
  and trusted normalized schemas, then tail-call the existing pattern,
  JavaScript-module, or handler instantiation path.
- [x] Derive trusted artifact source space from the resolved binding/link and
  pass it to materialization; keep it distinct from the selected pattern's
  later execution `spaceSelector`.
- [x] Resolve a schema-light `byRef()` through `ModuleRegistry`; fail if no
  trusted concrete schema is available.
- [x] Apply pattern scope and raw space-selector modifiers after base resolution
  and before child instantiation.
- [x] Do not execute implementation code during decode, value resolution, or
  property inspection.

WP2.4 implementation audit (2026-07-11): the serialized dynamic node keeps a
write-redirect factory binding plus the explicit trusted call contract; no
selected ref enters graph identity. The runner now installs a provisional
dependency subscription before invoking the initial sink callback, so initial
absence and even an immediate invalid-to-valid replacement cannot fall into a
run-before-subscribe window. A live factory whose hidden `spaceSelector` is a
Cell is converted to a link before Factory sealing, including when nested in a
frame-less setup argument.

Two existing fast paths required correction rather than extension. First, the
global evaluated-artifact index did not prove that the closure existed in the
binding's exact source space; both warm materialization and PatternManager load
now require exact-space availability before using that index. Second, named
and anonymous execution-space selection is asynchronous even when the artifact
itself is warm. That readiness remains node-local (it is not registered as
global scheduler background work), rereads the current selection, and keeps
artifact source provenance separate from the execution target. Focused dynamic
tests cover all three kinds, schema-light `byRef`, modifiers, source/target
separation, cell-derived selectors, no-code-before-validation, initial absence,
invalid recovery, and selector CFC provenance.

### WP2.5 — Supervise replacement and teardown

- [x] Make the factory cell a reactive dependency of one dynamic-node
  supervisor.
- [x] Give each selected child/action/handler generation its own cancellation
  scope and monotonically increasing generation token.
- [x] Add a scheduler/transaction generation guard: cancellation alone does not
  currently prevent an already-running async action from committing its final
  writes.
- [x] On a different canonical factory state, cancel the previous generation,
  fence late async writes/results, tear down result-owned internals and handler
  subscriptions, and instantiate the replacement. Equal-state replay is a
  no-op.
- [x] Preserve the call site's output binding and cause as the stable identity
  anchor across replacement.
- [x] Verify two distinct call sites still receive distinct output identities.
- [x] Cover replacement before settle, replacement after settle, same-factory
  replay, wrong-kind replacement, rejected cold load, and handler unsubscribe.
- [x] Specify output readiness: initial absence fabricates no result; during a
  cold/invalid replacement the stable output spot may retain its last committed
  value, but the canceled generation has no live subscriptions or writes and
  runner diagnostics carry pending/error state.
- [x] Cover stale cold load A completing after B is selected, owner/piece
  teardown while load/action work is pending, invalid-then-valid replacement
  recovery, replacement-only handler stream routing, and cold resume with the
  selected factory and stable output identity.
- [x] Make every post-await continuation reread the binding and check both owner
  and selection generation. Loading A may warm a cache after B is selected but
  must never instantiate A or reschedule a stopped owner.
- [x] Keep this immediate switch-latest lifecycle scoped to direct dynamic
  factory nodes. In WP2.6, cold readiness itself must not tear down a lift's
  prior result; once ready, existing lift replacement/commit semantics apply
  unchanged.

WP2.5 implementation audit (2026-07-11): cancellation groups are now latched,
so cleanup registered after teardown runs immediately instead of reviving a
retired owner. Scheduler action subscriptions and handler registrations carry
monotonic generations. Action generations are checked after queue waits and
authored awaits, before transaction commit/resubscription, and across conflict
readiness/retry continuations. Queued events retain the exact handler
registration that owned them; cancellation during presync/body or replacement
before dispatch aborts that intent rather than rerouting it to a newer handler.

Deterministic supervisor tests cover equal replay, warm and cold replacement,
wrong-kind and rejected-load recovery, owner teardown during a gated load,
distinct call-site identities, stable output retention, and handler-only-B
routing after A is canceled. The complete runner task reached
`874 passed (4676 steps), 24 failed (118 steps), 0 ignored (10 steps)`; every
new dynamic/CFC/cancellation/generation test passed. The remaining failures are
the already-audited legacy tool/list writer, replay-golden, and wish/profile
migration cluster, so the Stage 2 package completion gate remains unchecked
rather than being waived.

Expected runtime tests:

- new `packages/runner/test/dynamic-factory-node.test.ts`
- `packages/runner/test/patterns-dynamic.test.ts`
- `packages/runner/test/patterns-handlers.test.ts`
- `packages/runner/test/by-identity-handler-exec.test.ts`
- `packages/runner/test/map-op-by-identity.test.ts`

Likely supervision seams include `packages/runner/src/cancel.ts` and the action,
subscription, and scheduler modules under `packages/runner/src/scheduler/`.

### WP2.6 — Materialize factories at runner and scheduled callback boundaries

- [x] Preserve the three deliberate exposure forms: context-free data-model
  decode returns an inert shell; warm executable runner exposure returns a live
  callable synchronously; cold scheduled exposure uses an async readiness
  phase and invokes authored code only after a live callable exists.
- [x] Route schema-driven `asFactory` runtime reads through the materialization
  chokepoint without changing synchronous `Cell.get()` into a promise. Warm
  synchronous reads may return a live callable; cold adapters must use an
  explicit async runner boundary and may not leak a shell into authored code.
- [x] Before invoking a `lift` implementation or handler callback, recursively
  prepare only schema-declared `asFactory` leaves; do not eagerly walk unrelated
  opaque data.
- [x] Implement two-phase scheduled readiness: read/validate the factory in the
  action/event transaction; if cold, run no authored callback and commit no
  authored result, arrange a single-flight load outside that transaction, then
  retry and reread the current value under the same live owner.
- [x] Ensure the selection read that ultimately executes carries reactive and
  CFC provenance. Existing fail-open `presyncInputs` may prewarm caches but
  cannot be the correctness/security gate.
- [x] For lifts, reuse the normal reactive rerun loop. Keep the previous
  committed value/result-owned child while only cold readiness is pending; once
  ready, use the existing lift execution/replacement/commit behavior without
  importing direct dynamic-node immediate teardown semantics or claiming new
  commit atomicity.
- [x] For handlers, materialize bound context and event data per event. Context
  changes alone do not invoke the handler or replace prior event-owned results;
  a by-value event factory is an event snapshot and an explicit Cell retains
  Cell semantics.
- [x] Delay/requeue a cold handler event with the same complete durable intent:
  identity, origin lineage, commit/final callbacks, retry metadata, and deadline.
  Readiness deferral is not an authored attempt: it does not consume commit-
  retry budget, call the final callback, or mint a receipt.
- [x] Add a dedicated bounded readiness retry/backoff policy for transient
  artifact unavailability, independent of the authored event's `retries`
  setting. Missing/forged/wrong-kind/schema failure is terminal and fail-
  closed. Keep the enclosing handler stream subscribed, but create no handler
  body effects, normal receipt/result graph, or event-created child/action
  subscription before readiness.
- [x] Fence lift/event preparation by owner generation so teardown during load
  cannot reschedule or resurrect work. If A initiated a load and B is current
  on retry, authored code sees only B.
- [x] Keep cold readiness local. Add a same-parent upstream-produced factory
  regression proving parent startup does not wait on all nested factories;
  whole-parent prewarming remains optimization-only and an unused cold factory
  need never load.
- [x] Route direct dynamic dispatch through the same materialization helper
  while keeping graph binding dependency-only and non-executable.
- [x] Verify memory v1/v2 storage, patch/diff, and sync paths treat a canonical
  factory as an atomic codec value while still traversing its encoded state.
- [x] Cover `packages/memory/v2.ts` `encodeMemoryBoundary` /
  `decodeMemoryBoundary` with a focused
  `packages/memory/test/v2-factory-boundary-test.ts` round trip.
- [x] Add a fresh-runtime client/server round trip in which one runtime writes a
  factory, another decodes it, and a runner materializes/invokes it.
- [x] Add typed factory round trips through Cells, query-result proxies, pieces,
  nested arrays, and nested objects now that `asFactory` exists.
- [x] Verify cross-space links remain links, artifact source space is passed to
  loading, and a by-value writer durably replicates the artifact closure into
  the containing space before committing/enqueueing the Factory value.
  `spaceSelector` remains the execution target, and CFC labels survive the
  transactional selection read.
- [x] Parameterize warm and genuinely cold callback tests over all three factory
  kinds in lift input, handler context, and handler event positions. Assert the
  authored callback receives a callable, can invoke it through the ordinary
  direct path, and is not called before cold readiness.
- [x] Add deterministic loader gates/error injection rather than sleep-based
  races. Cover A-loading/B-selected reread, event retry identity, callback and
  receipt timing, kind/schema/missing failures, later valid recovery, and
  artifact-source versus execution-target spaces.

Concrete seams and focused tests:

- `packages/runner/src/cell.ts`
- `packages/runner/src/query-result-proxy.ts`
- the query/runtime adapters that expose decoded values
- `packages/runner/test/cell-proxy.test.ts`
- `packages/runner/test/query-result-proxy-fabric-primitive.test.ts`
- `packages/runner/test/query.test.ts`
- new `packages/runner/test/factory-input-materialization.test.ts`
- new `packages/runner/test/factory-input-loading-races.test.ts`
- `packages/runner/test/scheduler-event-receipts.test.ts`
- cross-space factory input and `inSpace()` reload tests

WP2.6 implementation audit (2026-07-11): schema-driven preparation now walks
only declared `asFactory` leaves, aggregates cold readiness without invoking
authored code, and starts no load when a later leaf fails terminal validation.
Warm and genuinely cold pattern/module/handler inputs are covered in lift,
handler-context, and handler-event positions. Explicit `Cell<Factory>` values
remain Cells; by-value event factories remain event snapshots. Cell and query
exposure is synchronous and fail-closed: raw reads retain inert shells, warm
schema-driven reads return live callables, and cold synchronous reads throw the
dedicated unavailable error so an inert shell never reaches authored code.

Scheduled readiness retains one event intent and independently bounds
transient artifact retries (three attempts with deterministic backoff). Owner,
action, and handler generations fence every post-await continuation, including
cancellation while readiness never settles and speculative-origin failure.
Loading remains local to the selected node/event: same-parent production does
not deadlock startup and unused cold factories issue no load. Deterministic
tests also cover A-loading/B-selected rereads, result-owned child retention,
terminal-then-valid recovery, all three CFC-labeled factory kinds, and exact
artifact-source versus execution-target spaces.

Fresh-runtime runner round trips cover all three factory kinds across
independent storage clients. Dedicated memory-v2 and piece-result tests prove
the inert-at-rest/live-at-runner boundary; complete memory tests pass
(`357 passed (139 steps)`). The complete piece task reaches `15 passed (61
steps), 1 failed (1 step)` with the new round trip green; its sole failure is
the already-audited keyless legacy pattern lookup in
`pull-materialization.test.ts`.

The cross-space by-value writer checkbox intentionally remains open. The
canonical synchronous cell writer rejects a Factory value unless the complete
artifact closure already exists in the exact containing space, satisfying the
spec's fail-closed “replicate or reject” rule without pretending a synchronous
API can await replication. Stage 4 async adapters must call
`ensureArtifactClosureInSpace` before enqueue/commit; that durable replication
half of the checkbox will be checked only with those adapter migrations.

Complete runner validation after WP2.6 reached `880 passed (4738 steps), 24
failed (118 steps), 0 ignored (10 steps)` in 3m31s. All new factory,
readiness, cancellation, generation-fencing, CFC, and round-trip suites passed.
The 24 failing test files remain the audited canonical-writer migration cluster:
legacy raw builtin/tool/list/patternTool values and their dependent
piece/profile/wish/replay fixtures. The package completion gate remains open
until Stage 4 migrates those writers; no failure is waived.

### Stage 2 completion gate

- [x] Factory-valued inputs, outputs, and stored cells carry `asFactory`.
- [x] Symbolic eager pattern/module/handler calls use one internal dynamic path;
  runtime-materialized lift/handler values use the same materialization
  chokepoint and then the ordinary direct callable path.
- [x] Direct live-factory calls have unchanged emitted code and behavior.
- [x] Dynamic replacement cancels/fences the prior generation without changing
  the stable output spot.
- [x] Scheduled cold readiness is node/event-local, does not deadlock parent
  start, never calls authored code with a shell, and preserves one durable
  handler event identity through retry.
- [x] Warm and cold resolution fail closed on kind or schema mismatch.
- [x] `deno task test` passes in `packages/api`, `packages/schema-generator`,
  `packages/ts-transformers`, and `packages/runner` using each package's
  available task names.

## Stage 3 — Pattern closure conversion

### WP3.1 — Add the compiler-only params-schema carrier

- [x] Add internal `withPatternParamsSchema(callback, schema)` next to the
  builder helpers, backed by a private callback WeakMap or equally unforgeable
  protocol.
- [x] Return the original callback so the helper can wrap the first argument of
  `pattern()` without changing public arity.
- [x] Make `pattern()` and `patternFromFrame()` read the schema synchronously
  before eager callback invocation.
- [x] Create a second symbolic root only when compiler metadata declares a
  params slot, and call the transformed callback as `callback(argument,
  params)`.
- [x] Persist the trusted params schema in the base pattern's internal factory
  state.
- [x] Carry that trusted schema through the internal Pattern/factory metadata
  used by cold resolution without exposing it as public input schema.
- [x] Reject an authored second callback parameter that lacks compiler-created
  metadata.
- [x] Keep the public callback type one-parameter and keep the public
  `PatternFactory` type free of `.curry`.

Expected files/tests:

- `packages/runner/src/builder/pattern.ts`
- `packages/runner/src/builder/factory.ts` and builder helper types
- `packages/runner/test/pattern.test.ts`
- `packages/runner/test/factory-input-types.test.ts`
- a compile-time API test proving authored `.curry` is unavailable

WP3.1 implementation audit (2026-07-11): the carrier is available only under
the transformer-owned `__cfHelpers` namespace; the authored runtime export
object and public API contain no carrier or curry member. Its private WeakMap
association is read before eager callback execution, creates a distinct params
root only for marked callbacks, and persists only `paramsSchema` in canonical
base factory state. Warm and cold materialization validate that private schema
against the resolved trusted artifact. The SES verifier accepts the carrier
only in pattern callback position and rejects its result as a standalone
module-scope value.

The builder serialization half of WP3.4's params alias vocabulary was pulled
forward deliberately: without `{ $alias: { cell: "params" } }`, a marked
callback could not preserve argument-1 references for WP3.3. Runtime resolution
and ownership of that pseudo-root remain in WP3.4. Ordinary authored two-arg
callbacks still fail closed at runtime as a defense in depth. WP3.3 adds the
source-level boundary diagnostic, including required, defaulted, rest, and
alias-erased second parameters, while admitting only the compiler-created
params-schema carrier. That completes the previously open checkbox without
relying on `Function.length`.

### WP3.2 — Implement the internal one-shot curry derivation

- [x] Attach `.curry(params)` only to the internal transformed-code view of a
  pattern factory.
- [x] Require exactly one argument and always bind callback argument 1.
- [x] During graph construction, validate the complete symbolic params record's
  keys and alias/factory shapes against the trusted schema without prematurely
  materializing reactive captures. Validate concrete values and links again
  when WP3.4 populates the hidden params cell.
- [x] Keep factory-valued params that originate from Cells/links as symbolic
  aliases with their original link parent/artifact source; curry must not bind
  the currently selected `Factory@1` snapshot.
- [x] Return a new branded pattern factory with identical public
  `argumentSchema`/`resultSchema` and canonical hidden `params`.
- [x] Make `materializeFactory()` reapply canonical params from a decoded bound
  factory, validate them against trusted base metadata, and still reject an
  unbound closure-bearing base. Reconstruct the one-shot bound derivation for
  both direct setup and dynamic dispatch.
- [x] Preserve the root token/ref and any scope/space derivations regardless of
  modifier order.
- [x] Throw on a second curry, including an equal/empty value.
- [x] Throw when the base pattern has no compiler-declared params slot.
- [x] Never merge, remove, override, or narrow public input fields.
- [x] Test zero- and two-argument internal curry calls, missing/extra keys,
  wrong concrete values, symbolic Cells/links, second curry, and curry on a
  capture-free pattern.

WP3.2 implementation audit (2026-07-11): `.curry` exists on the runner-private
factory view while the authored `PatternFactory` type remains unchanged. It is
a one-shot derivation over canonical factory state, validates one complete
plain symbolic params record, preserves Cell/link/factory bindings without
reading them, rejects ordinary functions and kind/schema mismatches, and keeps
the root token, durable artifact ref, scope, and space selector across either
modifier order. Serializing a curry whose factory param comes from public input
produces an argument alias in hidden state rather than snapshotting the current
selected Factory value.

Warm and cold materialization compare the private schema with the resolved
trusted base, reapply curry before scope/space modifiers, reject malformed
params through the same validator, and reject a closure-bearing unbound base
before it can reach authored code. WP3.2 intentionally proves reconstructible
bound callable state, not executed closure semantics: invocation-owned params
cell creation and callback argument-1 binding at runtime remain WP3.4.
The complete runner task after WP3.2 reached `882 passed (4749 steps), 24
failed (118 steps), 0 ignored (10 steps)` in 3m25s; the same audited Stage 4
canonical-writer migration cluster accounts for every failure.

### WP3.3 — Generalize nested-pattern hoisting

- [x] Update transformability validation so an inline `pattern(...)` in a
  pattern-owned context is a supported value, not only a `patternTool` or
  `*WithPattern` special case.
- [x] Collect every non-module lexical capture, including Cells/Reactives and
  all three factory kinds; keep verified module-scoped helpers lexical.
- [x] Preserve a captured factory input's symbolic binding through the hoist
  and params record. Only schema-driven runtime delivery or direct dynamic
  invocation may read/materialize its selected value.
- [x] Rewrite the hoisted callback to receive public input in argument 0 and a
  deterministically ordered capture record in argument 1.
- [x] Generate public argument/result schemas plus the private params schema.
- [x] Wrap the callback with
  `withPatternParamsSchema(callback, paramsSchema)` before passing it to
  `pattern()`; assert there is no fourth `pattern()` argument.
- [x] Hoist a capture-free base to a deterministic `__cfPattern_N` declaration
  and register it through `__cfReg`.
- [x] Replace a capturing authored site with exactly
  `__cfPattern_N.curry({ ...captures })`.
- [x] Replace a capture-free authored site with the bare hoisted factory and no
  curry call.
- [x] Apply normal cause assignment after the site rewrite.
- [x] Reject non-portable captured functions and unrepresentable capture
  schemas with source-located diagnostics.
- [x] Fail closed when an inline wrapper touches a `FrameworkProvided` path
  until WP3.6's trusted forwarding metadata is available; general closure
  conversion must never temporarily permit capture or authored supply.
- [x] Verify a wrapper around a bound pattern creates a new hoisted wrapper and
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

WP3.3 implementation audit (2026-07-11): closure conversion now has a dedicated
`PatternStrategy` plus one wrapper/original-aware callback and legacy-carrier
classifier shared by closure analysis, callback policy, and builder hoisting.
That shared descriptor was required because later transformer stages see
cloned/wrapped calls whose immediate syntax no longer identifies the authored
boundary. Legacy `patternTool` and `*WithPattern` carriers remain on their old
paths; ordinary nested patterns hoist/register deterministic bases and retain
exactly one site-local curry only when captures exist. The zero-authored-input
case uses a collision-free synthetic `never` argument-0 root so closure params
remain argument 1 even when public input is absent.

Capture analysis keeps verified module helpers lexical, preserves Cell and all
three branded factory bindings symbolically, and narrows the SES callable
exception to semantically branded first-class factories. Arbitrary functions,
unrepresentable capture schemas, authored second callback parameters, and a
rest-style public argument 0 now produce source-located diagnostics.
`FrameworkProvided` provenance is traced through aliases (including widened
module aliases), casts, conditionals, destructuring, and object/array/tuple
containers; nested public input, captures, invocation, or exposure fail closed
until WP3.6 supplies trusted forwarding metadata.

The original plan underestimated schema-contract loss after TypeScript widens
`PatternFactory<Input, Result>` to `PatternFactory<Input, any>`. A compiler-only
WeakMap hint now carries ordered exact contracts for pattern, module/lift, and
handler factories through aliases, selected object/tuple members,
destructuring, objects, arrays, readonly tuples, unions, and conditional
containers (including lowered `ifElse`). Multiple runtime contracts sharing one
semantic TypeNode emit ordered `anyOf` alternatives and deduplicate only by
compiler contract identity, since text-identical TypeNodes can carry different
nested factory metadata. Ordinary module-scope builders are registered through
the same path, so mixed inline/module alternatives remain exhaustive. For
inferred lift and handler schemas the hint is attached only after capability
shrinking, so the containing `asFactory` schema matches the schemas actually
injected at the builder call. No serialized factory state or wire schema becomes
compiler authority, and runtime equality is not weakened.

Two related code/plan discrepancies were repaired rather than hidden. The
shared transformer test environment omitted the production
`commonfabric-schema.d.ts` augmentation, and its single-schema `pattern`
overload returned `any` even though the runner overload infers the callback
result. Both now match production behavior. Type information alone still
cannot reproduce authored JSON Schema-only keywords, so schema-bearing factory
contracts also carry statically evaluated JSON-compatible const schemas in the
compiler-only hint. Proven-stable const bindings and static spreads are
supported; property mutation, mutable aliases, exports, arbitrary-call escapes,
and executable schema discovery are rejected rather than snapshotting a value
that can diverge, running authored code, or emitting a knowingly mismatched
contract. Stable `toSchema<T>(options)` sources are the one compiler-owned
non-literal form: their exact generated value and options are obtained through
the same schema-generator implementation that later emits the call. These
requirements added schema-generator and static-JSON seams not named in the
original file list.

Red/green coverage includes the required fixture matrix, callback argument
separation, deterministic names/order, factory and Cell captures, legacy
carrier routing, FrameworkProvided laundering attempts, exact nested contracts,
alias/shorthand propagation, same-type alternatives, nested metadata,
selected members/destructuring, conditional containers, authored and inferred
schemas for all three factory kinds, `toSchema` options, schema-authored
metadata/constraints, and static-schema failure. The focused WP3.3 matrix
passes `163 passed, 0 failed`; complete affected tasks pass in API
(`16 passed`), schema-generator (`28 passed (251 steps)`), and ts-transformers
(`1116 passed (742 steps)`). Nested and schema-preservation goldens are
byte-stable and direct
transformed-output inspection confirms argument 0/public input, argument
1/private params, one curry, no fourth `pattern()` argument, and exact
containing `asFactory` schemas.

### WP3.4 — Add the hidden params root and invocation-owned cell

- [x] Extend the alias vocabulary with `{ $alias: { cell: "params", ... } }`
  without treating `params` as piece input.
- [x] Give each bound-pattern invocation one immutable hidden params cell with a
  deterministic result-relative cause and `paramsSchema`.
- [x] Link that cell from result metadata under `params` and link it back to its
  owning result for resume/teardown.
- [x] Resolve bound params against the parent binding context before writing or
  linking them into the hidden cell.
- [x] Preserve nested link parents and cross-space links rather than copying
  values across spaces.
- [x] For factory-valued params, preserve artifact-source provenance separately
  from any selected pattern factory's execution `spaceSelector`; resume must
  not infer source space from the target modifier.
- [x] Update `unwrapOneLevelAndBindtoDoc`, `sendValueToBinding`, and direct
  sub-pattern setup to accept the params pseudo-root only when the invocation
  owns a params cell.
- [x] Populate the same deterministic cell from serialized `Factory@1` state on
  resume before child nodes start.
- [x] Pre-sync the params cell during reload before graph execution and factor
  the schema-aware projection currently used for argument updates rather than
  applying public-input defaults to params.
- [x] Tear it down with the owning result and never expose it through public
  argument projection.
- [x] Define teardown in terms of cancellation, subscription ownership, and
  reachability. If durable owned cells are not physically deleted on ordinary
  stop, prove they cannot be reused or rescheduled by a later generation.
- [x] Reject invocation of a closure-bearing base factory with absent params.
- [x] Prove a public field and closure param with the same name remain distinct.
- [x] Traverse nested factories and preserve CFC labels inside params.
- [x] Add an A-with-params → B-with-different-params → A dynamic replacement
  test proving a stable output spot, generation-fenced captured writes,
  generation-correct params/CFC labels, and resume of only the active
  generation. Gate A's cold reload and prove stale completion cannot revive its
  old params generation after B is selected.

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

WP3.4 slice audit (2026-07-11): WP3.1 had already emitted the private `params`
alias spelling, but the public metadata vocabulary and both runtime binding
directions still rejected it. `MetaLinkField`, deterministic meta-cell minting,
`unwrapOneLevelAndBindtoDoc`, and `sendValueToBinding` now accept `params` only
through an owning result's explicit metadata link; absence still fails closed.
The same slice removes a second mismatch outside the original seam list:
`builder/json-utils.ts` used to expand every pattern implementation as a legacy
graph, discarding bound `Factory@1` state. New pattern nodes retain the admitted
callable directly, while the named legacy graph serialization branches remain
for unbranded stored readers.

WP3.4 invocation-cell slice (2026-07-11): Runner dispatch now keeps a static
bound pattern factory callable while resolving its hidden state against the
containing pattern's argument/params context. Setup writes the complete params
record into the deterministic invocation-owned cell before result projection or
node startup, records both metadata directions, and deliberately does not apply
public argument defaults. A fresh closure-bearing base without params is
rejected before setup writes or node execution. Focused coverage proves the
capture remains a link to the parent argument cell, same-named public/private
fields remain separate, and the existing nearby binding/serialization/reload
matrix passes `10 passed (114 steps)`.

WP3.4 reload/lifecycle slice (2026-07-11): transformed symbolic Cells are now
validated from their declared schema without forcing a link address before a
runner frame owns a space. Fresh-runtime resume walks canonical bound factory
nodes as well as legacy pattern modules and awaits each deterministic params
cell before subscribing child nodes. Nested captures remain parent-relative
links, including a cross-space second hop; runner-derived CFC label views bridge
same-transaction parent/params writes and are stripped from the durable link
after recording policy input.

The A-with-params -> B-with-params -> cold A-with-new-params regression exposed
an additional scheduler interaction: the reactive selector sink could queue
behind A's pending authored promise, allowing A to commit before cancellation.
An exact-source storage-notification fast lane now only rereads and preempts the
old generation; execution still waits for the normal transactional scheduler
path. The test proves the stale A value is never observed, B and the final A use
only their own params, old subscriptions do not rerun, the output identity is
stable, and cold readiness retains B until the active A generation is ready.
Each changed result contains the current generation's selector confidentiality
label; prior confidentiality may remain conservatively joined because CFC
labels are monotone at the stable durable output identity.
Durable params cells are deliberately not physically deleted: the deterministic
address is reused only after cancellation, with one complete immutable Fabric
value installed atomically for the new generation. The focused regression
matrix passes `10 passed (58 steps)`.

WP3.4 nested-factory provenance slice (2026-07-11): a linked factory captured
inside nested params cold-loads from the terminal selector link's space while
its `spaceSelector` remains solely the child execution target. The gated cold
regression stops the owner before readiness returns and proves the loaded code
cannot revive it; the warm path invokes the same nested value in its selected
execution space. The params cell retains the nested link rather than a factory
snapshot and persists the selector's confidentiality label at the exact nested
path.

The warm red test exposed a provenance violation in dependency-only selector
reads: after correct source-aware materialization, the supervisor and its
scheduled child called ordinary `Cell.get()` on the intermediate params path.
That attempted a second materialization using the params cell's containing
space, then retried readiness indefinitely. These authorization/CFC reads now
use `getWithoutFactoryMaterialization()`; only the runner's source-aware
materialization chokepoint produces the executable callable. The complete
focused WP3.4 matrix passes `11 passed (61 steps)`.

The required complete runner package task was also run at this boundary. It
reported `876 passed (4752 steps), 36 failed (127 steps)`: the new WP3.4 tests
all pass, while the remaining failures are the still-unmigrated Stage 4 writer
and compatibility surface (including legacy pattern tools, list-op identity,
direct pattern/inSpace readers, wish/reload paths, and their stored fixtures).
This is a recorded later-stage gate, not a waived green package result; the
complete task must pass after Stage 4 before final handoff.

### WP3.5 — Unify list callback lowering

- [x] Change array callback lowering so `map`/`filter`/`flatMap` capture through
  a bound `PatternFactory`, with no sibling params object in newly emitted
  nodes.
- [x] Make `mapWithPattern`/`filterWithPattern`/`flatMapWithPattern` accept the
  bound factory as the new canonical shape.
- [x] Make the new canonical node carry only `{ list, op }` and invoke the
  pattern with public `{ element, index, array }`; hidden captures flow only
  through the params root.
- [x] Keep a dual-read runtime path for stored legacy `{ op, params }` nodes
  during the compatibility window.
- [x] Keep old public overloads only until source migration and stored-data
  gates pass; mark them deprecated rather than teaching them new semantics.
- [x] Keep `packages/runner/src/builtins/op-pattern-ref.ts` and
  `packages/runner/src/builtins/list-op-argument-usage.ts` only on the named
  legacy adaptation path; new `Factory@1` nodes go through generic
  materialization.
- [x] Isolate the legacy branch in `Runner.substituteOpPatternRefs()` so it
  cannot remain an accidental writer dependency.
- [x] Update closure-capture diagnostics to recommend inline patterns, not
  manual sibling params.
- [x] Regenerate affected transformer goldens and test nested map/filter/flatMap
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

WP3.5 transformer slice (2026-07-11): array callbacks now use the same private
params carrier as nested patterns. Captured callbacks have public list fields
only in argument 0, private captures only in argument 1, one
`withPatternParamsSchema`, and exactly one `.curry(captures)` at the call site;
capture-free callbacks remain uncurried. Every newly emitted
`mapWithPattern`/`filterWithPattern`/`flatMapWithPattern` call has one factory
argument. Registry-owned callback recognition handles the curried wrapper,
while the old direct-parent plus sibling-params recognition remains explicitly
legacy-only.

The code exposed an unrecorded `thisArg` discrepancy: the old transformer
forwarded the optional JavaScript array receiver as a third `*WithPattern`
argument, but the runtime ignored it. The canonical `{ list, op }` contract
cannot preserve that accidental behavior, so reactive array lowering now fails
closed with `array-method:this-arg-unsupported`; the spec records that decision.
Focused coverage passes `7 passed`, golden regeneration passes `369 steps`,
direct transformed-output inspection shows the required root split and one
curry, and the complete transformer task passes `1123 passed (742 steps)`.

The follow-up golden inventory found one stale
`map-type-assertion.expected.jsx` using the retired sibling-params shape, but no
matching input fixture exists in the current tree or its history. The fixture
runner therefore never exercised or regenerated that file. It was removed as
an orphan rather than retained as false compatibility coverage. The remaining
expected outputs use one-argument `*WithPattern` calls, and the policy
capability-analysis source sample now uses the same canonical spelling; the
explicit legacy routing fixture remains separately named and exercised.

WP3.5 canonical writer/runtime slice (2026-07-11): the new one-argument public
overloads write only `{ list, op }` and the old two-argument overloads remain
explicitly deprecated writers of `{ list, op, params }`. Runtime dispatch
branches on ownership of the sibling `params` field, not on whether `op` is
already branded. Canonical bound factories bypass `$patternRef` substitution,
materialize through the generic Factory chokepoint, and receive only the fixed
public list triple; the old resolver and argument-usage inference are confined
to the stored legacy branch. The initial red failed because substitution tried
to discard a bound factory's `paramsSchema`; the warm bound-capture and legacy
matrix now passes `3 passed (27 steps)`, including stable map aggregate and row
identities. Cold readiness, replacement/resume, CFC/scope, fixture migration,
and the complete package gates remain in the final WP3.5 slice below.

WP3.5 cold-list slice (2026-07-11): canonical list coordinators now resolve the
factory's terminal selector link and use that source space for generic
materialization. A missing artifact parks only the current coordinator action
with scheduler-owned readiness; no child callback runs and no authored write
commits before the artifact is live. The retry rereads the current selector and
list, while action-generation fencing drops a superseded selection or stopped
owner. Deterministic coverage passes `2 passed (5 steps)` for source-space
loading, list mutation during load, cold-A/warm-B replacement, owner teardown,
and the existing warm bound-list matrix. The aggregate WP3.5 checkbox remains
open until live replacement/resume, CFC/scope, fixture migration, and the full
package gates are green.

WP3.5 list-replacement slice (2026-07-11): the first red preserved the call
site's row link but produced a sparse result after A(params1) was replaced by
B(params2), because unchanged indices never restarted their row runners. Each
canonical list coordinator now owns a switch-latest selector supervisor. An
exact-address cancellation lane watches both the stable op binding and its
terminal source, stops every cached row before an authored promise can settle,
and leaves materialization/activation on the normal transactional path. A
monotonic selection generation restarts present and removed-then-reappearing
rows in their existing result cells; child actions also read the stable op
binding for reactive and CFC provenance. Focused coverage now passes for all
three list builtins across A -> B -> A, different params on reused artifacts,
stale async completion, old-subscription teardown, equal-state replay,
aggregate/row identity, and replacement while a cached row is absent. The cold
and replacement matrix passes `3 passed (6 steps)` with the warm canonical and
explicit legacy reader tests included.

WP3.5 bound-list resume slice (2026-07-11): a MemoryV2-backed fresh-runtime
regression compiles the list callback separately from its parent so loading the
parent cannot accidentally warm the callback artifact. The stored node has no
sibling params, the canonical bound state retains the hidden linked factor,
and the second runtime loads the callback independently by identity. Aggregate,
row, and params-cell addresses all survive resume; changing only the linked
factor afterward updates `[22, 43]` to `[8, 15]` without identity churn. No
production change was needed for this slice. The focused resume/list matrix
passes `5 passed (8 steps)`.

WP3.5 canonical CFC/scope slice (2026-07-11): the first red showed a bound
user-scoped capture leaving filter's aggregate in space scope; after that was
fixed, a second red showed the canonical selector's materialization read
smearing `map-factory-secret` onto map's outer aggregate. Filter and flatMap now
derive pre-mint aggregate scope from the authenticated factory's terminal
source and value-bearing bound-param links. Map deliberately keeps list scope
while its row cells narrow independently. The coordinator marks factory
materialization as dependency seeding, and every child action rereads the
stable binding so selector/capture labels reach map rows and filter/flatMap
selection structure without sibling leakage. The warm, cold, replacement, and
CFC matrix passes `4 passed (7 steps)`; all eight existing pointwise-flow steps
also pass.

WP3.5 fixture-migration slice (2026-07-11): 58 empty two-argument list calls in
runner tests and benchmarks now use canonical one-argument factories. A
test-only installer gives hand-built PatternFactories the same warm durable
artifact association transformed modules receive; it does not make arbitrary
functions serializable or fabricate a cold source closure. Exactly one
structural legacy `{ list, op, params }` execution fixture remains per builtin,
and the only public two-argument calls left are the three deliberately
deprecated writer-overload assertions in `list-factory-writer-shape.test.ts`.
The compiled-module-verifier sample and comments use canonical one-argument
output. The canonical batch passes `9` suites / `86` steps, list edge cases pass
`5` steps, all eight affected list-scope cases pass, and the verifier passes
`45` steps. Broader files still expose the separately tracked Stage 4
patternTool/factory-writer failures, so the aggregate WP3.5 gate remains open.

### WP3.6 — Preserve `FrameworkProvided` obligations through wrappers

- [x] Record trusted framework-provided paths in compiler/artifact metadata for
  each base factory. Do not add them to `FactoryStateV1` or trust paths carried
  by `Factory@1` wire data.
- [x] When an inline wrapper calls such a factory, synthesize the required
  system fields into the wrapper's argument schema/binding and forward their
  aliases transitively.
- [x] Keep those fields out of the model-facing tool schema.
- [x] Inject the value from the wrapper tool instance's stable identity and
  carry that exact value to the ultimate call.
- [x] Reject an authored literal, capture, or closure param that attempts to
  supply a framework-provided path.
- [x] Enforce the same trusted-metadata-only rule when a materialized factory is
  called inside a lift implementation or handler callback; runtime context or
  event data cannot supply or launder the path.
- [x] Fail closed when a required system value or stable tool identity is
  unavailable.
- [x] Cover one wrapper, multiple wrappers, a dynamic stored factory, and a
  cross-space invocation.

Expected tests:

- `packages/api/test/framework-provided.test.ts`
- `packages/runner/test/cfc-agent-tool-input-integrity.test.ts`
- `packages/runner/test/sandbox-id-auto-provision.test.ts`
- transformer fixtures for framework-input synthesis and rejection

Replace the hard-coded framework-field handling in
`packages/runner/src/builtins/llm-dialog.ts` only after the generic trusted
metadata path has equivalent fail-closed coverage.

WP3.6 core implementation audit (2026-07-11): compiler-emitted
`withFrameworkProvidedPaths(callback, paths)` metadata is admitted only in the
verified callback-carrier position with canonical static object-property paths.
The builder stores those paths in runner-private trusted-artifact side tables;
derivations retain them, while `FactoryStateV1` and `Factory@1` encoding remain
unchanged. Inline wrappers synthesize direct argument-0 Cell aliases into the
inner call, including nested paths and transitive wrapper chains. Authored
literals, captures, spreads, wildcard/array paths, and scheduled lift/handler
event or context laundering fail at compile time.

Dynamic symbolic calls carry a separate compiler-owned expected path set on
the node invocation contract. Warm and cold materialization compare it exactly
with the resolved trusted artifact metadata, so same-schema privileged and
ordinary factories cannot substitute for each other; the mismatch path retains
the previous result and a later cold valid selection recovers without output
identity churn. Schema-derived `asFactory` contracts reconstruct only their
public kind/schema fields and cannot grant framework paths.

The existing legacy `patternTool` value stores a bare Pattern graph and loses
runner-private artifact side tables. Making that graph a new authority channel
would contradict this work's trust boundary. Therefore the remaining
model-facing schema stripping, stable tool-instance identity injection, and
cross-space adapter proof stay unchecked here and are gated on WP4.1's direct
factory tool shape. The hard-coded `sandboxId` compatibility path remains until
that replacement has equivalent coverage.

Focused validation before the package gates: the two transformer suites pass
`15 passed, 0 failed`; builder metadata passes `3 passed, 0 failed`; dynamic
authority passes `1 passed (2 steps), 0 failed`; and compiled-bundle verifier
coverage passes `48 steps`.

The complete transformer task passes `1138 passed (742 steps), 0 failed`.
The complete runner task reports `878 passed (4747 steps), 44 failed (146
steps), 0 ignored (10 steps)`: every new WP3.6 regression passes, while the
failures remain in the recorded Stage 4 canonical-writer/compatibility cluster.
That count also includes traversal and stored-identity oracles whose graph
identity intentionally changes now that symbolic calls carry an explicit
compiler-owned `frameworkProvidedPaths: []` authority expectation. Those
oracles and dependent fixtures must migrate with the Stage 4 writers; this is
an open aggregate package gate, not a waived green result.

### Stage 3 completion gate

- [x] Exact emitted IR uses a two-parameter callback,
  `withPatternParamsSchema`, and at most one transformer-only `.curry(params)`.
- [x] No emitted or runtime path merges closure params into public input.
- [x] Hidden params cells resume, preserve links/CFC, and tear down with their
  owner.
- [x] List callbacks emit only bound-factory nodes while old stored nodes still
  read correctly.
- [x] Framework-provided values remain system-supplied through wrapper chains.
- [x] Transformer, runner, API, schema-generator, and focused CFC tests pass.

## Stage 4 — Boundary and `patternTool` migration

### WP4.1 — Teach tools and external adapters the new factory value

- [x] Update `BuiltInLLMTool` in `packages/api/index.ts` to accept a direct
  `PatternFactory` and `{ pattern: PatternFactory, ...metadata }` as canonical
  authored shapes, while retaining the legacy tool object as a deprecated
  compatibility input.
- [x] Update LLM tool discovery to accept a PatternFactory directly and derive
  the model-facing input from its public `argumentSchema`.
- [x] Keep optional description/presentation data in an ordinary metadata
  wrapper with a `pattern` field and no `extraParams`.
- [x] Invoke through the same async/source-space-aware `materializeFactory`
  chokepoint as runner execution. An imperative adapter materializes its
  current snapshot and then uses the ordinary direct callable path; it never
  calls an inert shell or invents a reactive binding.
- [x] Update `packages/runner/src/schema-format.ts` and LLM schema formatting to
  understand `asFactory` without subtracting closure params.
- [x] Update `packages/runner/src/builtins/llm-schemas.ts` and
  `packages/runner/src/builtins/llm-dialog.ts` to write/read the new shape while
  retaining the legacy reader.
- [x] Preserve `description` and `useResultSchemaForObservation` in the metadata
  wrapper, while sending only reduced `{ description, inputSchema }` data to
  `packages/llm`; factory state never crosses into a provider request.
- [x] Update `packages/cli/lib/callable.ts` to discover/materialize canonical
  factories and keep legacy `{ pattern, extraParams }` reads.
- [x] Update `packages/fuse/callables.ts`, `packages/fuse/callable-path.ts`,
  `packages/fuse/tree-builder.ts`, and `packages/fuse/cell-bridge.ts` likewise.
- [x] Replace FUSE's plain `JSON.stringify`/function-source fallback for factory
  leaves with Fabric codec projection; otherwise callable values would be
  dropped or exposed as source text.
- [x] Treat callable functions as weak-key-capable discovery values and keep a
  direct pattern factory's `*.tool` projection as a leaf.
- [x] Decode tagged factory JSON on supported FUSE writes to an inert shell and
  let the runner boundary materialize it.
- [x] Before CLI/FUSE or handler-event code commits/enqueues a by-value Factory,
  durably replicate its artifact closure into the containing destination space
  or reject the write. A context-free decoded value carries no alternate
  source-space authority.
- [x] Verify runtime, CLI, and FUSE discover and invoke the same stored factory
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

WP4.1 public type slice (2026-07-11): `BuiltInLLMTool` now accepts a directly
branded `PatternFactory` and a metadata wrapper whose `pattern` is the factory
and whose canonical shape has no `extraParams`. The deprecated Pattern graph
compatibility arm requires `extraParams`, which keeps the old stored shape
distinguishable without admitting arbitrary functions. The red type check was
`TS2322` for the direct factory; the API package now passes `17 passed, 0
failed` and the focused type check is green.

WP4.1 runner/LLM slice (2026-07-11): tool discovery now admits a direct
PatternFactory or `{ pattern: PatternFactory, ...metadata }`, derives only the
public argument schema, retains the dynamic entry cell, and prepares the
current factory snapshot through the source-space-aware runner materializer
before ordinary invocation. Cold catalog construction parks with
`RetryWhenReady`; the cross-space regression then invokes the loaded factory
in the destination while preserving its source artifact space. Trusted
framework paths alone remove model fields and supply nested runtime values from
the stable tool-entry identity. An ordinary same-named field stays
model-visible, model pins are overwritten, and missing stable identity fails
closed. The provider still receives only reduced tool metadata.

The static `LLMToolSchema` cannot honestly express the canonical direct entry
as `asFactory`: that extension is an exact kind/input/output contract, while a
tool map is intentionally heterogeneous. A permissive authored wildcard would
be a new authority channel. The schema file therefore explicitly retains its
legacy object/metadata projection, while the canonical reader uses the raw
Fabric-coded entry, validates admitted `Factory@1` state and pattern kind, and
materializes it. This is a documented plan/code representational split, not a
weakened schema contract.

The first canonical CFC subagent run also exposed an existing utility bug:
`deepEqual` read the inherited `constructor` property through a query proxy,
which turned `Object` into an attempted stored-data read and was correctly
rejected as an arbitrary function. A focused red test now guards that boundary;
prototype comparison avoids the data read and preserves the factory/CFC result
redaction path.

Focused green evidence: `generate-object-tools.test.ts` passes `1 passed (21
steps)`; `sandbox-id-auto-provision.test.ts` passes `2 passed (14 steps)`;
`schema-format.test.ts` passes `20 passed`; the cold cross-space tool regression
passes `1 passed`; and the complete deep-equality file passes `1 passed (59
steps)`. The CLI/FUSE adapter bullets and their package gates remain open for
the next WP4.1 slice.

WP4.1 CLI/FUSE slice (2026-07-11): shared callable classification now admits
only direct or metadata-wrapped pattern factories, rejects arbitrary functions
and non-pattern factory kinds, and derives CLI/FUSE help from the factory's
public argument/result schemas. CLI execution resolves the terminal factory
cell, passes its source space to async `prepareFactory`, invokes the resulting
live factory with only public input, and leaves the legacy
`{ pattern, extraParams }` merge reader intact.

FUSE treats callable functions as weak keys, hides a discovered direct factory
behind a stable `*.tool` leaf, and emits tagged `fvj1:` codec text for factory
values that remain in JSON projections; function source is never exposed.
Supported JSON/scalar/handler writes decode tagged leaves to inert shells.
Before a by-value cell write or handler enqueue, the bridge walks nested
factory state and asks PatternManager to verify the complete artifact closure
in the destination. Because context-free JSON carries no trusted source-space
authority, that verification is deliberately same-space and rejects missing
closures rather than guessing a source.

`callable-path.ts` required no representation change: its existing `.tool`
grammar is already value-shape-neutral, and its tests cover both piece/entity
and root/nested tool paths. This is the only listed file with no code delta.
The aggregate runtime/CLI/FUSE tests use the same Factory@1 public contract;
runtime and CLI invoke it through source-aware materialization while FUSE
projects the same schema and callable leaf.

The complete FUSE task passes `204 passed, 0 failed, 1 ignored`. The complete
CLI task first exposed two ordered Stage 4 fixture migrations: dev fixtures
passed runtime `schema()` results where exact factory contracts require static
schema bindings, and the headless wish writer put live Cell objects into an
immutable candidates URI. Dev fixtures now use static contracts; the wish
factory receives a warm content-addressed ref and candidates write explicit
links. The final CLI task passes its main lane at `895 passed (249 steps), 0
failed, 1 ignored` and its subprocess lane at `20 passed (91 steps), 0 failed`.

### WP4.2 — Install explicit compatibility readers

- [x] Accept legacy `{ $patternRef, argumentSchema, resultSchema }` wherever a
  pattern factory is expected and adapt it to `FactoryStateV1`.
- [x] Retain the full surrounding module descriptor when reading legacy
  `$implRef`; do not reinterpret `$implRef` as a factory artifact ref.
- [x] Accept legacy `{ pattern, extraParams, ...metadata }` tool values and
  preserve their historical merge/precedence rules only in that reader.
- [x] Accept stored legacy list nodes carrying sibling `{ op, params }`.
- [x] Make canonical transformed/repository writers emit `Factory@1`, inline
  pattern wrappers, and bound list factories only. Until Stage 5, explicitly
  deprecated public legacy APIs may still produce old shapes for compatibility.
- [x] Add fixtures for every legacy shape before changing writers.
- [x] Add diagnostics or counters sufficient to determine whether legacy values
  remain in supported persistent stores; do not log params or other user data.

WP4.2 audit: the legacy `$patternRef` reader now adapts the exact refs-only
shape to an inert `Factory@1` shell at the runner materialization boundary. It
does not execute during context-free decoding, and the resulting reference
still passes through the normal trusted artifact-resolution path. The `$implRef`
reader remains a whole-module-descriptor compatibility path and is never used
as `FactoryStateV1.ref`. The historical tool input merge and list sibling
`params` paths remain isolated compatibility readers.

The runner exposes process-local compatibility counts for `patternRef`,
`implRef`, `tool`, and `list` reads. They retain only a kind and count: no
params, authored values, identities, or user data. These counters provide
rollout evidence but do not satisfy any Stage 5 stored-data or compatibility-
window gate by themselves.

Focused fixtures cover refs-only adaptation, full `$implRef` descriptor
identity, legacy tool callback boundaries, and legacy list writer shape. The
focused compatibility suites pass. The existing hand-built
`map-op-by-identity` fixture remains red because its direct factories do not
yet carry durable refs; that is an ordered WP4.3/WP4.4 canonical-writer fixture
migration, not a compatibility-reader redesign.

The complete CLI package task passes (`895 passed (249 steps), 0 failed, 1
ignored`; subprocess lane `20 passed (91 steps), 0 failed`). The complete
runner task remains an open Stage 4 aggregate gate: it first fails on another
hand-built tool factory without a durable ref, runtime `schema()` values used
as factory contracts in compiler fixtures, and a stale captured-binding schema
in the profile pattern. Failed setup then cascades into cross-space and
auto-start assertions in the shared test process. These fixtures must be
migrated with the canonical writers before the Stage 4 package gate can be
checked; this audit does not represent the runner task as passing.

### WP4.3 — Migrate repository `patternTool` callers

For every caller, replace
`patternTool(searchPattern, { entries })` with an inline `pattern` whose public
input contains only the caller-supplied fields and whose closure invokes the
original pattern with `entries`.

- [x] Migrate `packages/patterns/cfc-agent-prompt-injection-demo/main.tsx`.
- [x] Migrate `packages/patterns/deep-research.tsx`.
- [x] Migrate `packages/patterns/google/core/gmail-importer.tsx`.
- [x] Migrate `packages/patterns/google/core/google-calendar-importer.tsx`.
- [x] Migrate `packages/patterns/notes/note.tsx`.
- [x] Migrate `packages/patterns/shopping-list.tsx`.
- [x] Migrate the affected files under `packages/patterns/system/`, including
  default app, knowledge graph, omnibox, quick capture, space overview,
  suggestion, suggestion history, and summary index.
- [x] Migrate `packages/cli/integration/pattern/fuse-exec.tsx` and any current
  non-test caller found by the inventory command below.
- [x] Replace the old structural `PatternToolResult` type in
  `packages/patterns/examples/summary-index-tester.tsx`, if still present when
  this stage begins.
- [x] Update `packages/patterns/index.md` only where generated summaries or
  public examples change.
- [x] Update `packages/patterns/test/source-coverage/commonfabric-stub.test.ts`
  so source coverage models the new public API while retaining an explicitly
  named legacy fixture if needed.
- [x] Verify every wrapper remains readable at the call site and does not expose
  captured values in the public tool schema.
- [x] Run a final source inventory and classify every remaining hit as API,
  compatibility reader, migration fixture, or historical documentation:

  ```sh
  rg -n "patternTool|PatternToolResult|extraParams" packages docs/common \
    --glob '!packages/patterns/deprecated/**'
  ```

WP4.3 audit (2026-07-11): every supported repository caller now uses a readable
inline `pattern` closure. Public fields remain callback argument 0; captured
Cells, lists, configuration, and existing sub-patterns flow through the private
argument-1 params record emitted by closure conversion. The CLI FUSE fixture and
summary-index tester now declare direct `PatternFactory` output types. The
patterns source-coverage stub models direct factories as the public shape and
keeps its old writer under an explicitly named legacy type/function boundary.

The final inventory has no production `patternTool(...)` call outside the
deprecated compatibility constructor itself. Remaining hits classify as:
deprecated API/writer declarations, compatibility readers and diagnostics,
explicit legacy tests/fixtures, transformer migration work assigned to WP4.4,
live compatibility documentation, and historical documentation. No production
patterns caller or CLI integration pattern remains in that set.

Repository migration exposed several real plan/code discrepancies rather than
ordinary caller edits. Exact factory contracts require static schema artifacts,
so runtime `schema()` fixture values were replaced with equivalent static
schemas. Hand-built canonical factories need installed content-addressed refs;
legacy keyless graphs remain accepted only at their named compatibility
boundaries. Warm indexed artifacts remain synchronously executable without
granting durable authority in an unrelated space. Canonical synchronous writers
still reject unreplicated closures, while the runner-owned raw-node adapter uses
`RetryWhenReady` to await exact-space replication before retrying its immutable
input write. This preserves `run()`'s synchronous API and keeps cold loading at
an explicit runner boundary.

Static and dynamic `.inSpace(...)` coverage also found that a resolved anonymous
dynamic selector was discarded when the materialized factory still carried its
empty authored selector. Pattern-node setup now retains the dynamic module's
resolved target as the fallback. Named, anonymous, link-derived, warm, cold, and
fresh-runtime cross-space tests pass with the execution selector distinct from
artifact source provenance.

The full runner migration required deterministic structural identity for
deprecated keyless pattern graphs before and after their compatibility ref is
minted. The three affected traverse-replay oracles were regenerated: invocation
outcomes and read counts are unchanged, while legacy JSON data-URI document ids
move to the canonical Fabric data-URI identity. The replay suite passes all four
fixtures and the regeneration left `deno.lock` untouched.

Complete package evidence for this work package: patterns passes `58 passed (29
steps), 0 failed`; CLI remains green at `895 passed (249 steps), 0 failed, 1
ignored` plus subprocess `20 passed (91 steps), 0 failed`; runner passes `929
passed (4897 steps), 0 failed, 0 ignored (10 steps)` in 4m25s. The representative
summary-index transform shows public input at callback argument 0, closure params
at argument 1, and exactly one transformer-emitted `.curry(...)`.

### WP4.4 — Stop canonical production of legacy list and tool shapes

- [x] Remove canonical transformer, internal tool, and repository-source
  construction of `PatternToolResult` and `extraParams`; isolate the deprecated
  public `patternTool` constructor as a named legacy writer until Stage 5.
- [x] Remove transformer hoisting/callback-boundary special cases that exist
  only to produce `patternTool(pattern(...), extraParams)`.
- [x] Remove transformer validation messages that recommend `patternTool`.
- [x] Ensure newly transformed list callbacks cannot emit sibling `params`.
- [x] Keep separately named, well-tested compatibility readers for old stored
  values; do not leave ambiguous branches in the canonical writer.
- [x] Add source/fixture assertions that fail if a new canonical writer emits
  `extraParams` or legacy list params.
- [x] Classify the five transformer `patternTool-*` fixture pairs and the
  patternTool cases in `validation.test.ts`,
  `unknown-capture-validation.test.ts`, `transform.test.ts`,
  `policy/callback-support.test.ts`, and `ast/call-kind-coverage.test.ts`:
  migrate semantic closure cases to inline-pattern coverage and retain only
  explicitly named legacy API/reader cases.

WP4.4 audit (2026-07-11): `patternTool` remains available only as the explicitly
deprecated `{ pattern, extraParams }` compatibility writer. Its dedicated
callback boundary, nested-pattern exclusion, whole-call hoister, validation
diagnostic, opaque-origin classification, and reactive-factory classification
are removed. Inline patterns passed even to that deprecated helper now use the
ordinary nested-pattern path, including `withPatternParamsSchema` and exactly
one compiler-emitted `.curry(...)` when captures exist. One deliberately named
`legacy-pattern-tool` call kind remains solely to prevent the plain legacy
writer call from being mistaken for reactive execution; an inventory test
pins that narrow source footprint.

Of the five old transformer fixture pairs, `basic-capture` and `no-captures`
remain as explicitly named legacy-writer compatibility fixtures. The redundant
local-variable, multiple-capture, and pre-filled-params pairs were removed;
their closure semantics are covered by the general nested-pattern fixture
matrix, while legacy pre-fill reading remains covered in runner, CLI, FUSE, and
LLM compatibility suites. Validation, unknown-capture, callback-policy,
call-kind, and pipeline tests now assert ordinary pattern semantics or explicit
legacy routing rather than a privileged `patternTool` callback path.

All six production sibling-params list writers were migrated back to ordinary
`.map(...)` authoring: background admin, BAM school dashboard, calendar change
detector, United flight tracker, and both USPS stages. Direct transformed-output
inspection shows `mapWithPattern(boundFactory)` with one argument. The sole
capturing case emits one `.curry({ pieces })`; capture-free adapters pass bare
hoisted factories. Source inventory rejects authored `patternTool(...)` and
manual `*WithPattern(...)` calls in supported patterns/background sources, and
transformer tests assert every lowered list family has exactly one factory
argument. The background compiler shim was updated to exercise the public
`.map(...)` source shape rather than modeling the removed sibling params.

The deprecated public API types and writer are marked `@deprecated`; canonical
diagnostics no longer recommend them. Schema formatting, LLM, CLI, and FUSE
`extraParams` branches are retained and labeled as compatibility readers. No
Stage 5 reader or public API deletion is implied.

Complete package evidence: transformers passes `1137 passed (736 steps), 0
failed` in 18s; patterns passes `59 passed (29 steps), 0 failed`; background
piece service passes `12 passed (48 steps), 0 failed`; API passes `17 passed, 0
failed`. Representative `cf check --show-transformed --no-run` inspections pass
for all five migrated production files (the USPS, United, BAM, and calendar
checks retain only the pre-existing Gmail mergeability warning).

### Stage 4 completion gate

- [x] A PatternFactory works as an LLM tool directly and inside a metadata
  wrapper.
- [x] CLI and FUSE discover/materialize/invoke all three serializable factory
  kinds where their callable surfaces permit them.
- [x] Repository source callers use inline pattern closures, not `patternTool`.
- [x] Canonical transformer/repository writers emit no `extraParams`, legacy
  `$patternRef` factory value, or sibling list params; deprecated public legacy
  APIs remain isolated and tested until Stage 5.
- [x] Legacy tool/list/module fixtures still read with their old semantics.
- [x] Pattern, runner, LLM, CLI, FUSE, transformer, and docs checks pass.

## Stage 5 — Compatibility removal and closeout

Stage 5 is a separately scheduled cleanup. Do not infer that source migration
alone authorizes deleting readers for durable values.

### WP5.1 — Satisfy removal gates

Stage 5 was authorized as a pre-launch cleanup on 2026-07-12. The product/runtime
owner confirmed there are no supported deployed patterns or durable stores that
must survive this change and explicitly approved wiping pre-launch data. Because
there is no supported rollout population, the deployed-writer window and
zero-reader-telemetry window are not applicable; the only supported client is
the current pre-launch tree, whose Factory@1 coverage is pinned by the Stage 1-4
matrix and final package checks. This decision satisfies the durable-reader
gates without inventing production evidence that does not exist.

- [x] Confirm all supported source trees contain no `patternTool` caller.
- [x] Add a CI/source-inventory assertion with zero `patternTool`,
  `PatternToolResult`, or writer-side `extraParams` hits outside an allowlist of
  compatibility tests and historical docs.
- [x] Confirm deployed writers have emitted only `Factory@1` for at least the
  agreed compatibility window. (Pre-launch: no supported deployed writers;
  owner-approved waiver.)
- [x] Confirm persistent stores have been migrated, expired, or explicitly
  approved for a wipe; record the evidence and decision in this plan.
- [x] Confirm legacy tool and list reader diagnostics show no supported usage
  for the agreed window. (Pre-launch: no supported runtime population;
  owner-approved waiver.)
- [x] Confirm every supported client/runtime version can read `Factory@1`.
  (The current pre-launch tree is the complete supported client set.)
- [x] Obtain an explicit product/runtime owner decision before deleting a
  durable compatibility reader.

### WP5.2 — Remove legacy APIs and readers

- [x] Remove `patternTool`, `PatternToolFunction`, and `PatternToolResult` from
  `packages/api/index.ts`, runner builder exports, and trusted builder factory
  wiring.
- [x] Remove transformer `patternTool` call-kind, boundary, validation, and
  hoisting special cases.
- [x] Remove LLM/schema-format/CLI/FUSE `extraParams` compatibility branches.
- [x] Remove legacy list overloads and sibling-params readers.
- [x] Remove legacy pattern-factory `$patternRef` adaptation only after its own
  stored-data gate passes.
- [x] Leave `$implRef` reconstruction for instantiated execution-module
  descriptors intact. It is current graph implementation identity, not a
  first-class factory-value encoding, and this cleanup does not authorize its
  removal.
- [ ] Remove factory-function `toJSON()` compatibility only after every Fabric
  boundary uses registered codec dispatch. Direct `Pattern.toJSON()` therefore
  retains the full-graph compatibility form; canonical Fabric writers use the
  Factory@1 codec and no longer emit `$patternRef`.
- [x] Keep negative fixtures that prove deleted writers/readers stay deleted.
  The supported-source inventory rejects the removed API/writer tokens, public
  API types reject the legacy tool shape, and runtime tests reject arbitrary
  functions and missing durable factory refs.

### WP5.3 — Update live documentation and archive the plan

- [x] Update `docs/common/README.md` and the relevant pattern composition,
  reactivity, types/schema, LLM, CLI, and FUSE docs for first-class factories.
- [x] Update live transformer behavior/inventory docs and
  `packages/ts-transformers/docs/array-method-callback-pipeline.md` so they show
  bound factories rather than sibling params.
- [x] Reconcile `docs/specs/sandboxing/SES_SANDBOXING_SPEC.md`,
  `docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md`,
  `docs/specs/ts-transformer/ts_transformers_type_driven_behavior_inventory.md`,
  `docs/specs/ts-transformer/ts_transformers_design_deltas.md`, and
  `packages/ts-transformers/docs/derive-to-lift-design.md` with the shipped
  closure and factory-call behavior.
- [x] Update `docs/specs/fuse-filesystem/2-path-scheme.md` and
  `packages/fuse/README.md` for direct factory `.tool` projection and tagged
  factory JSON.
- [x] Document the author-facing inline-pattern closure model with examples for
  passing, returning, storing, and invoking all factory kinds.
- [x] Document that `.curry` is not public API and that closure params never
  merge with public input.
- [x] Update component/pattern examples whose tool construction changed.
- [x] Reconcile the high-level checklist in
  `docs/specs/pattern-construction/rollout-plan.md`.
- [x] Mark the source specification implemented if all completion criteria are
  met.
- [x] Move this completed plan to `docs/history/plans/` with the required
  historical metadata in the final implementation change.

## Risk register

| Risk | Required mitigation |
| --- | --- |
| Internal graph serialization seals before `__cfReg` assigns a ref | Keep live-state traversal separate from durable sealing and test eager construction explicitly. |
| A copied brand or decoded shell gains execution authority | Keep data admission in data-model private tables and executable trust in runner-owned artifact indexes. |
| One Fabric operation still treats a function generically | Add shared factory-state dispatch before function shortcuts in conversion, codec lookup, freeze, clone, equality, hash, and traversal. |
| Factory hashing diverges from codec semantics | Reuse the existing codec-instance byte arm and pin it in the formal hash spec. |
| A replaced dynamic factory writes after cancellation | Fence every async write/result by supervisor generation and test replacement before and after settle. |
| A cold nested factory gates the whole parent and deadlocks on an upstream producer in that graph | Make readiness consumer-local; treat parent prewarming as cache-only and test a same-graph producer. |
| Cold A completes after B is selected or after the owner stops | Check owner and selection generations, reread after await, and permit stale completion to warm only the cache. |
| Handler cold preparation loses, duplicates, or prematurely receipts an event | Preserve the complete durable intent, use a dedicated bounded readiness policy independent of authored commit retries, keep the enclosing stream subscribed, and gate body/receipt/event-child creation on readiness. |
| Prewarming bypasses reactive or CFC authority tracking | Read and validate the value that executes inside the consuming action/event transaction; prewarm cannot authorize execution. |
| Artifact source space is confused with pattern execution `spaceSelector` | Load links from their source space; require by-value writers to replicate durably into the containing space before commit; test source and target independently. |
| A synchronous Cell/query path exposes an inert shell because cold loading is async | Keep synchronous executable exposure warm-only and require an explicit async runner boundary before authored callback or adapter invocation. |
| Wire/call-site schemas become authority | Resolve the trusted artifact first and require normalized equality; never elevate hints when trusted schemas are absent. |
| Closure params leak into public input or tool schemas | Maintain separate argument/params roots and assert public-schema snapshots at transformer, runner, LLM, CLI, and FUSE boundaries. |
| Wrapper patterns launder a `FrameworkProvided` value | Synthesize/forward trusted paths and reject authored literals or captures at compile time and runtime. |
| Params resume or teardown follows public-argument lifecycle by accident | Pre-sync the hidden root before execution, avoid public defaults, and define durable-cell ownership separately from physical deletion. |
| FUSE drops callable values or exposes function source | Project factories through the Fabric codec or `.tool` callable view before generic JSON/function handling. |
| Source migration accidentally deletes durable readers | Separate canonical writer removal from evidenced stored-data removal gates and retain named legacy fixtures. |

## Cross-stage validation matrix

### Fabric protocol

- [x] Encode/decode/hash/equality/clone/freeze every factory kind.
- [x] Round-trip nested factories, params, Cells/links, scope, and space
  selectors.
- [x] Reject arbitrary functions, copied symbols, malformed/cyclic states,
  pre-seal state, pseudo refs, kind mismatches, and schema mismatches.
- [x] Verify independent evaluations of equal factory state hash equally.

### Transformer

- [x] Golden output shows callback `(argument, params)`, callback-wrapped params
  schema, deterministic hoist, and exactly one internal curry at capturing
  sites.
- [x] Golden output contains no fourth `pattern()` argument, curry index, input
  merge, or curry at capture-free sites.
- [x] Symbolic calls lower for aliases/properties/elements and direct live calls
  remain direct; `lift` and handler callback parameters specifically remain
  direct after runner materialization.
- [x] List callbacks use bound factories with no sibling params writer.
- [x] Diagnostics cover invalid captures, authored callback argument 1, second
  curry, missing params, untransformable symbolic calls, and bad unions.

### Runtime

- [x] Warm and cold invoke stored pattern, module, and handler factories.
- [x] Direct symbolic replacement cancels/fences/tears down the prior generation
  while retaining the output spot; same-state replay does not restart it.
- [x] Warm/cold `asFactory` values reach lift and handler callbacks as ordinary
  callables. Cold readiness stays local, rereads after await, retains lift
  pre-readiness behavior without strengthening its commit contract, and
  preserves complete handler event intent/receipt timing.
- [x] Cross-space linked and by-value factories load from trusted artifact
  provenance while `spaceSelector` independently controls child execution.
- [x] Hidden params cells preserve same-named public fields, nested aliases,
  cross-space links, resume, teardown, and CFC labels.
- [x] Captured factories can themselves be stored and invoked.
- [x] Schema-light `byRef()` resolves only through trusted registry metadata.
- [x] Forged refs/metadata fail closed.

### Boundaries and migration

- [x] JSON, memory client/server, Cell/query, piece, cross-space, CLI, FUSE, and
  LLM tool paths preserve canonical factory state and callability after runner
  materialization.
- [x] Framework-provided inputs remain hidden from the model and cannot be
  authored/captured.
- [x] Legacy tool and list readers were removed after their explicit pre-launch
  owner-approved data-wipe gates.
- [x] No canonical writer emits `extraParams` or sibling list params.

## Final command checklist

Use the package's current task names if they change while this live plan is in
progress.

- [x] `deno task test` in `packages/data-model`
- [x] `deno task test` in `packages/schema-generator`
- [x] `deno task test` in `packages/ts-transformers`
- [x] `deno task test` in `packages/runner`
- [x] `deno task test` in `packages/llm`
- [x] `deno task test` in `packages/cli`
- [x] `deno task test` in `packages/fuse`
- [x] Root `deno task check`
- [x] Focused API type tests, including the negative public `.curry` assertion
- [x] A representative `deno task cf check ... --show-transformed --no-run`
  output inspected for closure and symbolic-call IR
- [x] Fresh-runtime cold round-trip integration for all three factory kinds
- [x] `deno task check-docs specs/pattern-construction`
- [x] `deno task check-docs plans`
- [x] `git diff --check`

Final validation (2026-07-12): data-model passes `49 passed (1992 steps), 0
failed`; schema-generator `28 passed (251 steps), 0 failed`; transformers `1134
passed (734 steps), 0 failed`; runner `918 passed (4863 steps), 0 failed, 0
ignored (10 steps)` in 3m36s; LLM `2 passed (20 steps), 0 failed`; CLI parallel
lane `895 passed (249 steps), 0 failed, 1 ignored` plus serial lane `20 passed
(91 steps), 0 failed`; FUSE `205 passed, 0 failed, 1 ignored`. API passes `16
passed, 0 failed`; the affected patterns and background-piece packages pass `59
passed (29 steps)` and `12 passed (48 steps)` respectively. Root `deno task
check` passes.

The fresh-runtime integration passes both suites and all five steps for pattern,
module, and handler factories. The final summary-index transform shows callback
argument 0 through `__cf_pattern_input`, private `{ entries }` at argument 1
under `withPatternParamsSchema`, one `.curry({ entries })`, one-argument
`mapWithPattern(...)`, and no `patternTool`/`extraParams`. The complete specs
docs check passes all 258 checked blocks, the common docs check passes all 114,
the plans docs check passes its checked block, the supported-source inventory is
empty, and `git diff --check` is clean.

## Overall completion criteria

- [x] Every content-addressed pattern/module/handler factory round-trips as a
  directly callable-after-materialization `Factory@1`; non-resolvable
  factories fail durable encoding.
- [x] Arbitrary JavaScript functions remain invalid Fabric values.
- [x] Factory-valued eager inputs and captures invoke through one symbolic
  dynamic runner path; runtime lift/handler inputs and imperative boundaries
  use the same materialization chokepoint before ordinary direct invocation.
- [x] Nested patterns preserve lexical semantics through callback argument 1
  and exactly one transformer-only `.curry(params)` per wrapper layer.
- [x] Public pattern input and closure params are never merged.
- [x] Refs, schemas, params, scope, space selection, CFC labels, equality, and
  hashes survive storage and cold reload.
- [x] `patternTool`, `$patternRef`, `extraParams`, and sibling list params have
  no supported writer or reader path; the pre-launch owner-approved data-wipe
  decision is recorded in WP5.1. Factory-function `toJSON()` remains separately
  gated and emits only the full compatibility graph, never `$patternRef`.
