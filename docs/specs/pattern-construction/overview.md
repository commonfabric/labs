# Pattern Graph Unification Spec

> **Terminology update:** Authored graphs are now referred to as “patterns.”
> The builder module still exposes helpers like `pattern(...)`, so this spec
> uses “pattern” when discussing authored artifacts and keeps the API names
> unchanged.

## Summary

Unify builder-time `Reactive` proxies and runtime `Cell` objects into a single
capability-driven cell model. The new model preserves pattern ergonomics
(implicit property access, helpers like `.map`) while producing a concrete
runtime graph with stable cell identifiers that the runtime can persist,
rehydrate, and tear down. Result cells become the canonical owners of graph
metadata, and lifts and handlers gain cause-based identifier stability.

## Goals

- Provide a single cell abstraction with explicit capabilities (`Opaque`,
  `Mutable`, `Readonly`, `Writeonly`) that behaves consistently in builder code
  and at runtime.
- Preserve existing pattern ergonomics—automatic property proxies and helper
  methods—so authored code remains concise.
- Capture a post-instantiation graph snapshot with concrete cell ids so the
  runtime can rehydrate or tear down dynamic graphs.
- Stabilize ids across small edits by deriving causes from input cells plus
  implementation details.

## Non-goals

- Redesigning scheduler semantics beyond the current "ignore self-writes" and
  100-iteration cap.
- Guaranteeing backward compatibility for the pre-metadata execution layout; it
  has been replaced by result-cell metadata and will later be complemented by a
  graph snapshot stored on the result cell.
- Delivering a full type-level capability system across the entire codebase in
  this phase; scope is builder APIs and runtime interfaces.

## Background

### Current builder flow

- `runtime/runner/src/builder/pattern.ts` pushes a frame, runs the author’s
  factory immediately, and records every `Reactive` and node it touches.
- Inputs are wrapped in `reactive` proxies so the builder can serialize graphs
  before runtime cells exist.
- `factoryFromPattern` walks the returned structure, records argument/result
  aliases, records derived internal cell descriptors, infers defaults, and
  emits JSON with `argumentSchema`, `resultSchema`, `derivedInternalCells`,
  `result`, and serialized nodes. No runtime cell ids exist yet.
- `Reactive` proxies track connected nodes, expose helpers like `.map()`, and
  rely on shadow refs to reuse parent cells without leaking frames.
- `lift` transforms a function into a module factory whose implementation runs
  reactively once live. Handlers wrap functions to produce streams and run once
  per event.

### Runtime instantiation today

- `Runner.setup` ensures each result cell has metadata links for `pattern` and
  `argument`, schema metadata, and raw `internal` manifest metadata. The
  manifest lists the derived internal cells associated with the result cell.
  The argument cell and each derived internal cell link back to their owning
  result cell through `result` metadata.
- Setup merges defaults into the argument cell, materializes
  `derivedInternalCells` into result-relative internal cells, and binds the
  serialized pattern graph via `unwrapOneLevelAndBindToDoc`.
- `Runner.#startCore()` iterates serialized nodes, resolves modules, and
  calls `instantiateNode`, turning aliases into real `Cell` instances through
  `sendValueToBinding`. The scheduler maintains reactivity.
- Handlers can emit new patterns; lifts that return patterns spawn fresh graphs
  and register teardown hooks.

## Repository Observations

- `runtime/runner/src/builder/reactive.ts` shows how `reactive` proxies
  track connected nodes via `.connect`, compute nested schema metadata with
  `ContextualFlowControl`, and expose helpers such as `.map`. Capability
  wrappers must recreate these affordances against real runtime cells.
- `runtime/runner/src/builder/factory.ts` pushes frames before calling the
  author factory. `createCell` expects the frame to provide a `cause` and an
  `unsafe_binding`, so the new wrappers must keep the frame lifecycle intact.
- `runtime/runner/src/runner.ts` writes pattern and argument metadata links,
  schema metadata, and the raw internal manifest onto the result cell. It later
  instantiates nodes by unwrapping aliases in `unwrapOneLevelAndBindToDoc`.
  Snapshot generation should hook into this instantiation path to capture
  concrete cell ids.
- `runtime/runner/src/create-ref.ts` hashes the supplied `cause` and recorded
  structure to derive entity ids. Stable causes therefore hinge on the data we
  pass into frames when new cells are materialized.

## Problem Statement

- Dual abstractions (`Reactive` vs `Cell`) confuse authors and limit helper
  availability.
- Patterns lack persisted runtime graphs, making rehydration and teardown fragile
  for handler-produced or reactive graphs.
- Alias metadata hinges on synthesized paths that shift as patterns evolve.
- Cause assignment for runtime-created cells is ad hoc, so ids change under
  small edits.

## Proposed Design

### Capability-driven cells

- Keep the core `Cell` implementation for runtime internals.
- Introduce capability wrappers (`Mutable`, `Readonly`, `Writeonly`, `Opaque`)
  that proxy `Cell` instances.
- Proxies map property access (`cell.foo`) to `cell.key("foo")` and surface
  helpers. `.map`, `.filter`, etc., appear on array-like cells; unknown schemas
  fall back to property access semantics.
- Invoking proxied helpers (`cell.map(...)`) routes through the proxy so we can
  distinguish reading vs executing members.
- Remove `.setDefault`; rely on schema defaults. Other helpers become available
  wherever semantically valid.
- Rename the combination of opaque refs and literals to `OpaqueValue` so lifts
  can accept cells or plain data uniformly.

### Pattern definition and authorship

- Treat `pattern(...)` as sugar for a `lift` whose inputs default to `Opaque`
  cells. The author’s factory still runs immediately, returning capability-
  wrapped cells instead of opaque refs.
- Property access in patterns continues to use proxy wrappers, so existing code
  (e.g., `items.map(...)`) keeps working.
- Lifts and handlers may accept an optional `cause`. When omitted, the runtime
  derives the cause from input cell ids and a hash of the implementation body.

### Runtime graph instantiation

- Instantiating a pattern produces a concrete graph snapshot with real cell ids,
  capability kinds, aliases, and module bindings.
- The snapshot is stored alongside the result cell's value and execution metadata.
  Documents written by the graph keep `result` metadata pointing back to their
  owning result cell.
- Snapshot metadata is sufficient to rehydrate handler-generated graphs and to
  tear down dynamic graphs before rebuilding them on change.

### Serialization format

- Define a versioned structure containing `graphVersion`, `cells`, `nodes`, and
  `links`.
  - `cells`: id, capability, cause, schema hash, redirect targets.
  - `nodes`: module reference plus input/output bindings rewritten to concrete
    cell ids.
- The shipped result-cell metadata layout is not backward compatible with the old
  execution layout. Snapshot rollout should append a `graph` payload without
  changing the existing `pattern`, `argument`, `internal`, and `result` metadata
  links.

### Cause generation

- Default cause: hash of (input cell ids + implementation source).
- Optional `cause` parameter on `lift`, `handler`, and pattern factories
  overrides the default when authors provide stable names.
- Causes feed into cell id derivation to keep ids stable under benign edits.

## Impacted Areas

- Builder APIs (`pattern`, `lift`, `handler`, helper exports).
- Runtime cell creation, alias resolution, and pattern instantiation.
- Serialization (`to-encodable-form.ts`, pattern manager persistence, result metadata).
- Tests and tooling that assume path-based aliases or reactive-only helpers.

## Implementation Plan

This work is being done as an **in-place migration** of the existing APIs rather
than a separate V2 system. See `rollout-plan.md` for detailed task breakdown.

### Phase 1: Type System Unification (In Progress)

1. **Unified Cell types**
   - Create `CellLike<>` branded type system replacing separate `Reactive` and
     `Cell` abstractions
   - Factor out capability traits: reading, writing, streaming, derives
   - Define `Reactive<>`, `Cell<>`, `Stream<>`, `ReadonlyCell<>`,
     `WriteonlyCell<>` via branded type combinations
   - Remove `ShadowRef`/`unsafe_` mechanisms
2. **Cell creation without immediate links**
   - Allow cells to be created before their cause/link is established
   - Add `.for(cause)` method for explicit cause assignment
   - Support automatic cause derivation with `.for()` as optional override layer
3. **Deferred execution model**
   - Change pattern lifecycle to run like a lift with deferred execution
   - Track created cells and causes in context during execution
   - Wire lift/handler returns to auto-assign causes to returned cells

### Independent Track: First-Class Factory Values (Proposed)

This track depends on content-addressed builder-artifact identity, not on graph
snapshots or the reactive-interpreter rollout. See
[First-Class Serializable Factories](./node-factory-shipping.md) and its
[implementation plan](../../plans/first-class-serializable-factories.md).

1. Make pattern, module/lift, and handler factory functions directly branded
   `Factory@1` `FabricValue`s.
2. Generalize ref binding, cold resolution, and symbolic invocation across
   factory kinds.
3. Closure-convert and hoist nested patterns, binding callback argument 1 with
   one transformer-only `.curry(params)` operation.
4. Replace `patternTool` with inline wrapper patterns.

### Phase 2: Graph Snapshot & Metadata (Deferred)

1. **Graph snapshot generation**
   - Build runtime graph snapshots during instantiation and store them in result
     cell metadata (implements the graph metadata described in the rollout plan)
   - Update rehydration/teardown logic to consume the snapshot
   - See `graph-snapshot.md` for schema details

### Phase 3: Cleanup

1. **Migration cleanup**
   - Remove legacy `Reactive` implementation
   - Remove `.setDefault`; rely on schema-level defaults
   - Deprecate JSON pattern representation in favor of graph snapshots
2. **Testing & documentation**
   - Integration test harness (see
     `docs/history/specs/pattern-construction/pattern-integration-tests.md`) -
     **DONE**
   - Update builder/runner tests for new helper behavior and metadata
   - Document unified cell types and `.for()` usage for pattern authors

## Testing Strategy

- Extend pattern and runner tests (e.g., `patterns/examples/todo-list.tsx`) to
  assert capability wrapper behavior, array helpers, and redirect semantics.
- Add instantiation tests that serialize the new graph snapshot and rehydrate
  it, focusing on handler-generated graphs.
- Verify scheduler behavior (ignored self-writes, iteration cap) with the new
  cell model.
- Regression tests for `cellA.set(cellB)` vs `cellA.redirectTo(cellB)`.

## Risks & Mitigations

- **TypeScript proxy typing gaps.** Provide dedicated wrapper types with helper
  availability per schema; fall back to index signatures when needed.
- **Snapshot size/performance.** Start with minimal metadata (ids, capabilities,
  aliases) and profile before expanding.
- **Backward compatibility.** Introduce shims so existing patterns run unchanged
  during migration.

## Open Questions

- How can authors override default helper capability mapping without undermining
  safety guarantees?
- What exact schema/versioning do we use for the graph snapshot payload?

## Next Steps

- Prototype capability wrappers and convert a sample pattern to validate
  ergonomics (see the superseded exploration in
  `docs/history/specs/pattern-construction/capability-wrappers.md`).
- Draft and iterate on the graph snapshot schema, then review with
  runtime/storage stakeholders (`graph-snapshot.md`).
- Implement rehydration against the stored graph snapshot and exercise it with
  a sample pattern while observing cause stability (`graph-snapshot.md`,
  `cause-derivation.md`).
- Plan the migration and documentation rollout for existing patterns
  (`rollout-plan.md`).
