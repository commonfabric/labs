---
status: historical
created: 2026-07-10
archived: 2026-07-10
reason: "Executed plan; DataUnavailable propagation and direct async results shipped."
---

# Data Unavailability Implementation Plan

This plan implements
[`docs/specs/data-unavailability.md`](../../specs/data-unavailability.md). The spec
is the behavioral contract; this document records the ordered implementation
work, exact integration seams, validation gates, and current execution status.

## Status

Executed on 2026-07-10. M0 through M5 are complete. The separately planned
`latestComplete()` snapshot helper remains follow-up work and was not an exit
condition for this cutover. This executed plan is archived under
`docs/history/plans/` following
[`docs/README.md`](../../README.md).

## Working Method

- Execute milestones in order. A later milestone may add tests or mechanical
  preparation early, but must not expose behavior whose substrate is absent.
- Use red-green TDD for each behavior slice: first add the smallest regression,
  confirm the intended failure, implement, then run the package test task.
- Treat these three generated artifacts as one invariant whenever availability
  is observed: capture type, capture schema, and exact-path runner policy.
- Inspect representative transformed output with
  `deno task cf check <fixture>.tsx --show-transformed --no-run`; source-level
  transformer reasoning is not sufficient.
- Preserve unrelated work. If implementation needs a file not named below,
  record the deviation here before expanding scope.
- Keep the `du-wb4` bead hierarchy and `FOCUS.md` synchronized with this plan.

## Decisions Fixed For Implementation

These choices resolve the remaining implementation-level ambiguity without
changing the design contract.

1. The concrete value is `DataUnavailable@1`, implemented as one
   `BaseFabricInstance` class with a `reason` discriminator. `pending`,
   `syncing`, and `schema-mismatch` are frozen interned instances; `error`
   carries a frozen `FabricError`.
2. The serialized module field is `unavailableInputPolicy`. Each entry contains
   one exact argument-relative `path` and an ordered, duplicate-free `reasons`
   list.
3. `isPending`, `hasError`, `isSyncing`, and `hasSchemaMismatch` are pure
   runtime predicates. `resultOf` and `observeAvailability` are runtime
   identities and transformer-recognized reactive aliases; no helper is a node
   factory. `resultOf` removes unavailable variants statically but emits no
   availability policy.
4. A synthesized guard lift widens only the probed capture. Its TypeScript
   input is `T | <guard variant>`, schema contains the same arm, and policy
   accepts only that guard's reason at that path.
5. Runner selection order is `error > pending > syncing > schema-mismatch`,
   then depth-first serialized argument order. The exact selected instance is
   propagated.
6. Ordinary schema failure of a locally complete argument produces the
   interned schema-mismatch value. Authored `undefined` remains valid when its
   schema admits it. A not-yet-covered read produces syncing.
7. Fetch and default generation APIs return explicit `AsyncResult<T>` unions.
   Ordinary consumers call `resultOf(request)` once for a statically usable
   view. The explicit advanced generation APIs are named `generateTextStream`
   and `generateObjectStream`; they retain the auxiliary state the current
   runtime actually implements (partial output, object-generation messages,
   and text grounding metadata) while sharing the same internal operation
   implementation as their default counterparts. Internal request hashes stay
   private. The current `generateObject` type advertises a cancellation stream
   its result schema does not create; the replacement API does not preserve
   that mismatch. `llmDialog` and its real cancellation stream are unchanged.
8. This is a source cutover, not a compatibility overload. Repository-owned
   patterns, fixtures, tests, and live docs move in the same milestone.
9. A lift carrying `unavailableInputPolicy` serializes as module kind
   `javascript-availability`. The current runner validates and executes that
   kind as JavaScript; older runners fail through their unknown-module path.
10. `latestComplete()` is a separately planned follow-up, not an exit condition
    for this migration. It will be a stateful atomic snapshot built-in; its
    implementation plan is `docs/plans/latest-complete.md`.

## Architecture And Dependency Order

```text
DataUnavailable codec + public predicates
                 |
                 v
module policy type + builder serialization
                 |
                 +-----------------------+
                 v                       v
transformer observation/widening    runner preflight/propagation
                 |                       |
                 +-----------+-----------+
                             v
            explicit async built-in state machines
                             |
                             v
             AsyncResult<T> + resultOf() surface
                             |
                             v
              repository consumer and docs cutover
```

The runner may recognize and propagate values before async producers emit
them. Async producers must not emit the marker until the data-model codec,
runner policy semantics, and compiler/runtime version surface are all present.

## M0 — Contract Baseline And Test Harness

### M0.1 Freeze the current contract

- [x] Write and doc-check `docs/specs/data-unavailability.md`.
- [x] Record the synthesized-lift capture-widening requirement.
- [x] Inventory the data-model, runner/built-in, and transformer seams.
- [x] Confirm focused fixture coverage. The inventory found that the existing
      data-model, transformed-AST, raw-module, runner, and rehydration harnesses
      can express the required regressions; add only suite-local helpers when a
      later red test requires one.

Files:

- `docs/specs/data-unavailability.md`
- `docs/plans/data-unavailability.md`
- `FOCUS.md`
- package-local test helpers, only as required by later tasks

Validation:

```sh
deno task check-docs specs
```

**M0 exit:** The spec and plan are live, and every implementation milestone has
an executable red test location.

## M1 — FabricType And Public Runtime Surface

### M1.1 Add `DataUnavailable@1`

Start with `packages/data-model/test/fabric-instances/DataUnavailable.test.ts`.
Cover:

- all four reason shapes and interned identity for non-error variants;
- error conversion from native `Error` through `FabricError`;
- concrete-brand checks rejecting structural lookalikes;
- deep freeze, frozen/unfrozen clone behavior, equality, and hashing;
- default JSON codec round trips and malformed-state decoding;
- unknown-registry behavior through the existing unknown-value path.

Then implement and register:

- `packages/data-model/src/fabric-instances/DataUnavailable.ts`
- `packages/data-model/src/fabric-instances/index.ts`
- `packages/data-model/src/codec-common/codec-type-tags.ts`

The codec state is the reason-discriminated record from the spec. Decode must
validate both the discriminator and exact required payload. Invalid state
becomes `ProblematicValue` through normal codec conventions.

### M1.2 Mirror the public types and pure helpers

Add the pattern-visible interfaces and helper types to `packages/api/index.ts`:

- `DataUnavailableReason`, `DataUnavailable`, and the four narrowed variants;
- `DataUnavailableVariant` and `DataUnavailableFor<K>`;
- predicate function types and declarations;
- both `observeAvailability` overloads;
- direct and advanced generation function types needed by M4.

Implement predicates and the identity cast in a small runner-owned helper
module, export them through `BuilderFunctionsAndConstants`, and inject them into
the `commonfabric` namespace in `packages/runner/src/builder/factory.ts`.
Expose no pattern-facing constructor or factory for markers.

Likely files:

- `packages/api/index.ts`
- `packages/runner/src/builder/data-unavailable.ts`
- `packages/runner/src/builder/types.ts`
- `packages/runner/src/builder/factory.ts`
- `packages/runner/src/index.ts`
- focused builder/API type tests

Validation:

```sh
deno test packages/data-model/test/fabric-instances/DataUnavailable.test.ts
deno task --cwd packages/data-model test
deno task --cwd packages/api test
deno test packages/runner/test/module.test.ts
```

**M1 exit:** Markers survive all value boundaries; pure helpers narrow only
real instances; normal pattern code can import the helper surface.

## M2 — Serialized Policy And Transformer Observation

### M2.1 Add path-scoped module policy

Define the API and runtime mirror for `UnavailableInputPolicyEntry` and add
`unavailableInputPolicy?: readonly UnavailableInputPolicyEntry[]` to `Module`
and derive scheduler options. Preserve it through:

- `lift()` construction and `toJSON()`;
- module cloning/serialization and cached-module reload;
- sandbox verification/plain-data checks;
- any module hashing or identity input that already includes module fields.

Use the versioned `javascript-availability` module kind whenever the
transformer emits availability policy. An older runner must fail closed rather
than ignore an unknown policy field and execute a marker as an opaque object.
When resolving a `ref` module to its registered implementation, merge the
execution-relevant authored metadata instead of preserving only
`defaultScope`; otherwise its policy and schemas are lost at execution time.

Reject malformed policy at the trust boundary: paths and reasons must be
arrays of known strings, paths are exact, and duplicate entries normalize
deterministically or fail closed.

Likely files:

- `packages/api/index.ts`
- `packages/runner/src/builder/types.ts`
- `packages/runner/src/builder/module.ts`
- `packages/runner/src/builder/json-utils.ts`
- `packages/runner/src/sandbox/plain-data.ts`
- module serialization/verifier tests discovered during the M0 inventory

### M2.2 Classify availability helpers by resolved symbol

Extend the closed Common Fabric runtime registry so aliases resolve to the same
classification. Guards remain pure calls. `resultOf` remains an identity
expression which strips unavailable members statically and preserves its source
reactive identity without adding policy. `observeAvailability` remains an
identity expression while attaching source-path and accepted-reason provenance
to cross-stage transformer state.

Test direct imports, namespace calls, aliased imports, `resultOf` source aliases,
aliases of observed values, and unrelated same-named functions.

Likely files:

- `packages/ts-transformers/src/core/commonfabric-runtime-registry.ts`
- `packages/ts-transformers/src/ast/call-kind.ts`
- `packages/ts-transformers/src/ast/dataflow.ts`
- `packages/ts-transformers/src/core/cross-stage-state.ts`
- `packages/ts-transformers/src/core/context.ts`
- `packages/ts-transformers/src/cf-pipeline.ts`
- corresponding `packages/ts-transformers/test/core/` tests

### M2.3 Widen guard-generated lifts before schema generation

For a guard used in pattern expression context:

1. identify the probed reactive capture and guard reason;
2. synthesize `T | DataUnavailableFor<reason>` for that capture only;
3. register that type before `buildCaptureTypeElements` and schema injection;
4. emit the matching exact-path policy in derive scheduler options;
5. keep the predicate call unchanged in the generated callback.

Add transformed-AST assertions for input type, input schema, policy, and pure
call. Add a runtime fixture proving an error reaches `hasError` while pending
propagates without calling the predicate node.

Primary files:

- `packages/ts-transformers/src/transformers/builtins/lift-applied.ts`
- `packages/ts-transformers/src/ast/type-building.ts`
- `packages/ts-transformers/src/closures/strategies/lift-applied-strategy.ts`
- `packages/ts-transformers/src/closures/utils/schema-factory.ts`
- `packages/ts-transformers/src/transformers/schema-injection.ts`
- `packages/schema-generator/src/schema-generator.ts`
- expression-rewrite call classification/emitters as required
- `packages/ts-transformers/test/data-unavailability.test.ts`
- a schema-generator regression proving that a registered qualified union
  member does not collapse the generated union schema to `true`
- fixture-based transformer cases

### M2.4 Support explicit `computed()` / `lift()` observation

For a guard over a visible `AsyncResult<T>` union, preserve the union in the
outer callback type/schema and infer exact reason policy from the guard. Carry
`observeAvailability(source, ...reasons)` provenance through aliases and
closure capture only for statically plain values. Widen that outer callback
argument type/schema and emit policy at its captured path. Diagnose:

- `observeAvailability` inside the callback whose boundary it attempts to
  modify;
- an availability guard inside a callback whose probed capture was not
  observed for that reason.

Cover selective reasons, all-reason observation, destructuring, generic
values, multiple captures, nested generated computations, closure hoisting,
and a computation which captures both `request` and `resultOf(request)`.

The last regression is mandatory: the usable alias must canonicalize to the
request source (or share its policy) so an accepted pending/error path is not
duplicated as an unaccepted input path.

Validation:

```sh
deno test packages/ts-transformers/test/data-unavailability.test.ts
deno task --cwd packages/ts-transformers test
deno task cf check <data-unavailability-fixture>.tsx --show-transformed --no-run
```

**M2 exit:** Every accepted unavailable reason is represented identically in
the generated capture type, schema, and module policy, including after reload;
`resultOf()` is a transparent, policy-free alias and guarded computations may
use its source and usable views together.

## M3 — Runner Preflight And Propagation

### M3.1 Centralize deterministic availability preflight

Add a runner helper which walks resolved bound inputs in serialized argument
order, cycle-safely, and returns one of:

- usable / fully accepted;
- selected unaccepted `DataUnavailable` plus path;
- syncing;
- locally complete schema mismatch.

The helper must inspect concrete markers before ordinary schema traversal, and
must not authorize a marker merely because an opaque object branch accepts it.
Exact-path policy is authoritative.

Primary files:

- `packages/runner/src/runner.ts`
- a focused helper module if it keeps traversal testable
- `packages/runner/src/traverse.ts` only if readiness needs a typed result
- `packages/runner/test/data-unavailability.test.ts`

Tests begin with:

- callback suppression and same-instance propagation;
- precedence plus same-reason argument-order tie break;
- accepted reason reaches callback while unaccepted reason propagates;
- exact outer-path acceptance does not admit a nested marker;
- object-shaped schemas cannot swallow a marker;
- authored valid `undefined` remains distinct;
- CFC/input-scope bookkeeping matches a normal result write.

### M3.2 Replace invalid-input `undefined`

Change JavaScript value-node argument rejection to write
`DataUnavailable.schemaMismatch()`. Preserve no-output handler/effect gating.
For value-producing effects, write propagated markers while suppressing the
external action.

Distinguish missing local coverage (`syncing`) from complete invalid data
(`schema-mismatch`) using the runner's read/query readiness information. Do not
infer syncing from an ordinary undefined value.

### M3.3 Apply the rule at other compute boundaries

Audit raw built-ins and container operators. Route `ifElse`, `when`, `unless`,
`map`, `filter`, and `flatMap` through the common preflight or implement the
equivalent boundary rule. Per-element computations propagate per element;
whole-container markers propagate as the whole result.

Likely files:

- `packages/runner/src/builtins/{if-else,when,unless,map,filter,flatmap}.ts`
- their focused tests
- runner scheduling tests for effects and durable reload

Validation:

```sh
deno test packages/runner/test/data-unavailability.test.ts
deno task --cwd packages/runner test
```

**M3 exit:** No value-producing JavaScript node returns `undefined` merely
because its input is unavailable or schema-invalid, and accepted observations
execute under exact-path policy.

## M4 — Explicit Async Built-In Results

### M4.1 Convert fetch state machines

Refactor the shared fetch machinery so each invocation owns one direct result
cell whose transitions are syncing, pending, `T`, error, or schema mismatch.
Use a distinct schema-validation failure path for `fetchJson`; HTTP/network/
execution failures become error markers. On input change, publish pending or a
propagated marker in the same logical transition that invalidates the old
success.

Apply the same contract to:

- `fetchBinary`
- `fetchText`
- `fetchJson<T>`
- `fetchJsonUnchecked`
- `fetchProgram`

`streamData<T>` remains stateful in this migration. It emits an indefinite
sequence of usable values while its transport remains live, so it needs a
separate direct-stream contract rather than the single-result transitions in
the DataUnavailable spec.

Primary files:

- `packages/runner/src/builtins/fetch.ts`
- `packages/runner/src/builtins/fetch-program.ts`
- `packages/runner/src/builtins/fetch-utils.ts`
- `packages/runner/src/builtins/index.ts`
- fetch tests

### M4.2 Split direct and advanced generation surfaces

Keep one internal operation-state implementation, then expose:

- `generateText(params): Reactive<AsyncResult<string>>`;
- `generateObject<T>(params): Reactive<AsyncResult<T>>`;
- `generateTextStream(params): Reactive<BuiltInGenerateTextStreamState>`;
- `generateObjectStream<T>(params): Reactive<BuiltInGenerateObjectStreamState<T>>`.

Default outputs project operation state to an explicit usable-value-or-marker
union. Advanced state retains pending/error compatibility fields only as an
explicitly stateful API, plus partial output, object-generation messages, and
text grounding metadata as applicable. Its `result` field is the same
`AsyncResult<T>`. Internal request hashes do not become public result data. Do
not expose a `cancelGeneration` member unless the raw result schema and
implementation actually create it; `llmDialog` remains the cancellable API.

Preserve post-commit effect gating, retries, queues, caching, tool calls,
`LlmDerived` CFC stamps, and rehydration. A response-schema failure is
schema-mismatch; provider/tool failures are errors.

Primary files:

- `packages/api/index.ts`
- `packages/runner/src/builtins/llm.ts`
- `packages/runner/src/builtins/index.ts`
- `packages/runner/src/builder/{module,factory,types}.ts`
- generation and CFC tests

### M4.3 Add `AsyncResult<T>` and `resultOf()`

The public signatures expose the honest union:

- `AsyncResult<T>` is `T | DataUnavailableVariant`;
- in-scope fetch/generate APIs return `Reactive<AsyncResult<T>>`;
- `resultOf<R>(value: R)` returns
  `Reactive<Exclude<R, DataUnavailableVariant>>` at the public type level;
- `resultOf()` is a pure identity and transformer-transparent reactive alias;
- it emits no node and no unavailable-input policy by itself.

Extend transformer analysis so a guard inside an explicit computation may
authorize a reason already present in its operand's visible union. Preserve the
existing `observeAvailability()` path for statically plain values carrying
propagated markers.

Canonicalize a `resultOf(request)` alias with `request` when both are captured
by one generated computation. Add the exact pending/error/success JSX example
from the spec as transformed-AST and runtime regressions.

Add compile-time tests for union visibility, guard narrowing, exclusion
inference, ordinary usable property access after `resultOf()`, and aliases or
wider unions which contain marker members.

Validation:

```sh
deno test packages/runner/test/fetch*.test.ts
deno test packages/runner/test/generate*.test.ts
deno task --cwd packages/api test
deno task --cwd packages/runner test
```

**M4 exit:** Every in-scope async built-in has an explicit `AsyncResult<T>`
surface, `resultOf()` provides the policy-free usable projection, no built-in
exposes stale success for changed inputs, and advanced generation capabilities
remain without duplicate operation implementations.

## M5 — Repository Cutover, Integration, And Documentation

### M5.1 Migrate consumers

Update every live repository use of `.result`, `.pending`, or `.error` on an
in-scope fetch/generation result. Use:

- `resultOf(request)` once when the pattern merely waits for usable `T`;
- `hasError` / `isPending` only where UI or behavior observes the state;
- the original `AsyncResult<T>` inside explicit computations when guards
  observe its states;
- `observeAvailability` only for statically plain values carrying propagated
  runtime markers;
- advanced stream APIs only for partial output, cancellation, messages, or
  grounding sources.

Do not copy deprecated pattern examples as style references, but keep code that
is still type-checked buildable if the package includes it.

Search gate:

```sh
rg -n '\.(result|pending|error|partial|groundingSources)\b' \
  packages/patterns packages/generated-patterns docs \
  --glob '*.ts' --glob '*.tsx' --glob '*.md'
```

Classify remaining hits; stateful APIs outside scope (`llmDialog`, SQLite,
compile-and-run, and the new advanced generation APIs) may legitimately remain.

### M5.2 Add end-to-end examples

Cover three authored patterns:

1. ordinary `resultOf(request)` consumption which waits through pending;
2. one pending/error/success JSX expression which uses guards on `request` and
   usable properties from `const result = resultOf(request)`;
3. `computed()` observing a visible request error directly, plus a separate
   propagated plain value which uses external
   `observeAvailability(value, "error")`.

Verify transformed output, execution, module serialization, and reload.

### M5.3 Update live docs and remove obsolete surfaces

Update fetch, LLM, reactivity, computed/lift, and debugging docs. Remove claims
that pending/invalid data is represented by undefined and remove obsolete
state-object examples. Keep historical documents unchanged.

Likely docs:

- `docs/common/capabilities/llm.md`
- `docs/common/concepts/reactivity.md`
- `docs/common/concepts/computed/`
- relevant fetch/pattern guides and debugging references found by search
- `packages/patterns/index.md` if exemplar descriptions change

### M5.4 Broad validation and plan closure

Run, in order:

```sh
deno fmt --check
deno lint
deno task check-docs specs
deno task --cwd packages/data-model test
deno task --cwd packages/api test
deno task --cwd packages/ts-transformers test
deno task --cwd packages/runner test
deno task check
```

Run the repository-wide suite if focused/package gates are green and the
remaining wall time is proportionate. Record any unrelated pre-existing
failure with an isolated rerun; do not change feature code to mask it.

After all checkboxes are complete:

- update the spec status from proposed to implemented;
- archive this plan to `docs/history/plans/` with the required history
  metadata;
- mark the `du-wb4` epic complete and clear or advance `FOCUS.md`.

**M5 exit:** Repository consumers and live docs describe only the new contract,
all required gates pass, and no pending implementation plan remains live.

## Risks And Guardrails

- **Availability union becomes a broad schema escape.** Always run concrete
  marker preflight before ordinary object schema matching; policy is exact-path
  and reason-specific even when `AsyncResult<T>` visibly includes the marker.
- **`resultOf` becomes a duplicate unaccepted capture.** Treat it as a
  transparent alias of its source. The full pending/error/success expression
  must capture one reactive identity or apply identical accepted policy to
  alias-equivalent paths.
- **Transformer artifacts drift.** Tests must assert type, schema, and policy
  together, including serialized/reloaded modules.
- **Pure guards are gated before execution.** A synthesized guard lift must
  widen its capture before capture-schema generation; widening only the guard's
  return or callback body is incorrect.
- **Stale async success.** Request changes must synchronously replace the old
  direct value with pending/propagated state before the new external effect.
- **CFC bypass during propagation.** A skipped callback's propagated write is
  still derived from the input and uses the normal scope, label, and commit
  path.
- **Persisted transient states.** Pending/syncing decode correctly but are not
  accepted as terminal cache hits; producers reconcile them on resume.
- **Compatibility ambiguity.** Default APIs are direct and advanced APIs are
  explicitly stateful. Do not maintain two meanings under one function name.
- **Migration breadth.** Use repository-wide symbol and property searches plus
  type-checking; tests alone will not find all pattern examples and prompts.

## Execution Log

- 2026-07-10: Wrote the design spec, added the generated-lift capture-widening
  invariant, passed `deno task check-docs specs`, initialized `du-wb4`, and
  completed the initial repository seam inventory.
- 2026-07-10: Completed M1. `DataUnavailable@1`, all four variants, codec and
  registry integration, public helper types, pure runtime guards, and the
  zero-node observation identity are implemented. Focused tests plus the full
  data-model and API package gates pass.
- 2026-07-10: Implemented M2 capture widening for direct guards and externally
  observed `computed()` / `lift()` inputs. Capture types, schemas, and exact
  policy paths now move together; policy-bearing lifts use the fail-closed
  `javascript-availability` module kind and malformed policy is rejected. The
  ts-transformers suite passed 1041 tests and schema-generator passed 246
  steps; representative emitted output was inspected directly.
- 2026-07-10: Implemented M3 propagation for JavaScript value/effect nodes and
  the `ifElse`, `when`, `unless`, `map`, `filter`, and `flatMap` raw boundaries.
  Focused runner suites pass; the full runner package gate remains outstanding.
- 2026-07-10: Revised the authoring contract after design review. Fetch and
  generation APIs now expose `AsyncResult<T>`; `resultOf()` is the zero-node
  usable projection. Reopened M2 for union-aware explicit-compute policy and
  alias canonicalization. Specified `latestComplete()` as a separately planned
  stateful atomic snapshot follow-up.
- 2026-07-10: Completed M2 through M5. Added exact-path availability policy,
  deterministic propagation and schema-mismatch values, direct fetch and
  generation results, stream-shaped advanced generation APIs, transparent
  `resultOf()` aliases, and the repository consumer/documentation cutover.
  Independent review also closed stale generation retry, cold-resume list,
  wish output-schema, and linked-readiness wakeup regressions.
- 2026-07-10: Final validation passed: data-model (1,939 steps), API,
  schema-generator (246 steps), ts-transformers (1,060 tests / 735 steps),
  runner (858 tests / 4,726 steps), active pattern compilation and source
  coverage, integration patterns, documentation checks, repository type check,
  lint, formatting, and diff hygiene.
