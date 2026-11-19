---
status: historical
created: 2026-07-13
archived: 2026-07-14
reason: "Executed plan; latestComplete shipped with recursive schema lowering and durable atomic snapshots."
superseded-by: docs/specs/data-unavailability.md
---

# `latestComplete()` Implementation Plan

This is the follow-up implementation plan for the
[`latestComplete()` contract](../../specs/data-unavailability.md#latestcomplete-snapshot-helper).
It is intentionally separate from the
[`DataUnavailable` implementation plan](./data-unavailability.md): the
`AsyncResult<T>` and `resultOf()` migration was complete while this stateful
snapshot primitive remained follow-up work.

## Status

Implemented 2026-07-14. The shipped helper exposes the recursively usable type,
injects one complete-value schema, retains one scoped persisted snapshot, and
preserves that snapshot across unavailable refreshes and cold resume.

## Fixed Decisions

1. `latestComplete()` is one stateful built-in node, not an identity cast.
2. Its one scoped result cell is the persisted snapshot. The output binding
   points to that cell; there is no second cache behind it.
3. The transformer derives one recursively usable schema from the TypeScript
   input type by removing `DataUnavailable` and all concrete unavailable
   variants at every union path.
4. The same schema drives input materialization, the value copied to output,
   and the authored usable return shape.
5. A successful materialization replaces the whole snapshot atomically. A
   failed or unavailable materialization performs no write once a snapshot
   exists.
6. Before the first complete snapshot, the output is the interned pending
   marker. Current unavailable reasons are intentionally not surfaced through
   this helper; callers inspect the original requests when they need them.
7. A valid authored `undefined` is a successful snapshot whenever the usable
   schema admits it. Initialization must use presence/status, never
   `value === undefined`.

## Architecture

```text
TypeScript input type
        |
        v
recursive DataUnavailable exclusion
        |
        v
one injected usable schema
        |
        +---------------------------+
        v                           v
status-bearing schema read     output cell schema
        |
        v
atomic whole-value copy on success
```

For an object input, this is an availability join because its one schema read
succeeds only when the complete object materializes:

```typescript
// Shown for illustration only.
const { repo, ticket, variable } = latestComplete({
  repo: repoRequest,
  ticket: ticketRequest,
  variable: regularReactiveCell,
});
```

The regular cell is copied only in the same successful read which also
materializes both requests.

## L0 — Contract And Test Harness

- [x] Add focused compile-time examples for root, nested, array/tuple,
      optional, object-union, and authored-`undefined` inputs.
- [x] Confirm the raw built-in harness can distinguish an absent output from a
      stored `undefined` after reload.
- [x] Confirm the schema-aware read returns an explicit success/failure status
      rather than using `undefined` as failure.
- [x] Fix the result-scope policy: either prove the declared result scope is
      sufficient for a copied snapshot or require the narrowest resolved input
      scope and make its scoped cell the sole persisted result.
- [x] Require a concrete generated usable schema, or add a link-aware marker
      preflight for `any` / `unknown`; never let an unconstrained schema hide a
      nested marker.

Primary test locations:

- `packages/ts-transformers/test/latest-complete-injection.test.ts`
- `packages/runner/test/latest-complete.test.ts`
- `packages/api/test/latest-complete.test.ts`

## L1 — Public Type And Transformer Schema

### L1.1 Add the recursively usable type

Define a public utility equivalent to:

```typescript
// Shown for illustration only.
type LatestCompleteValue<T> = LatestCompleteValueInner<
  Exclude<T, DataUnavailable>
>;

type LatestCompleteValueInner<T> =
  [T] extends [readonly unknown[]]
    ? { [K in keyof T]: LatestCompleteValue<T[K]> }
    : [T] extends [FabricInstance] ? T
    : [T] extends [object] ? { [K in keyof T]: LatestCompleteValue<T[K]> }
    : T;
```

The concrete utility must preserve framework leaf types rather than mapping
through their implementation properties. Use non-distributive object/array
branches after the explicit union exclusion; a naive fully distributive
recursive conditional can make schema/type validation recurse indefinitely.

Expose:

```typescript
// Shown for illustration only.
declare function latestComplete<T>(
  input: FactoryInput<T>,
): Reactive<LatestCompleteValue<T>>;
```

### L1.2 Classify and inject the schema

- Register `latestComplete` as a resolved-symbol reactive runtime call.
- Infer its complete input value type, unwrapping `Reactive` / cell-like input
  wrappers before schema generation.
- Resolve `LatestCompleteValue<T>` and inject its registered schema as the
  hidden runtime argument.
- Preserve registry transfers for synthetic and closure-derived types.
- Diagnose an unresolved generic/conditional usable type instead of silently
  accepting an unconstrained `{}` schema.
- Prove direct, aliased-import, and namespace calls all inject the same schema.

Likely files:

- `packages/api/index.ts`
- `packages/ts-transformers/src/core/commonfabric-runtime-registry.ts`
- `packages/ts-transformers/src/transformers/schema-injection.ts`
- `packages/ts-transformers/test/latest-complete-injection.test.ts`

**L1 exit:** The emitted schema contains no unavailable arm at any covered path
and agrees with the authored return type.

## L2 — Stateful Raw Built-In

### L2.1 Add the builder and raw registration

The public one-argument helper is transformer-lowered to a builder wrapper
which binds `{ value, schema }` into one raw node. Register that raw
implementation under a stable module reference and create its result cell with
the injected usable schema.

Likely files:

- `packages/runner/src/builder/built-in.ts`
- `packages/runner/src/builder/factory.ts`
- `packages/runner/src/builder/types.ts`
- `packages/runner/src/builtins/index.ts`
- `packages/runner/src/builtins/latest-complete.ts`

### L2.2 Publish only complete snapshots

For each action run:

1. Presence-read the result target without scheduling on or deriving CFC from
   the prior output. `NotFound` means genuinely uninitialized; any other read
   error is not an initialization signal.
2. Raw-probe the source root before schema traversal so a root Fabric marker is
   not hidden by property materialization.
3. Read the complete input through the injected usable schema using the
   status-bearing cell/schema API, preserving `{ ok: undefined }` as success.
4. If the read succeeds, reject any admitted nested marker and then write the
   schema-materialized value to the result as one atomic root update.
5. If it fails and the result has never been initialized, write the interned
   pending marker.
6. If it fails after initialization, perform no value write.

The action must subscribe to the reads needed for a later successful retry,
use normal output-scope and CFC derivation, avoid repeated identical writes,
and retain the snapshot across runner restart. The result's persisted presence
distinguishes never-written from stored valid `undefined`: a first successful
`undefined` run writes pending and then `undefined` in the same transaction, so
storage commits a present `undefined` rather than treating a naked initial
`set(undefined)` as no write.

### L2.3 Prove atomic join behavior

Test:

- single request: pending, first usable value, refresh pending retains prior,
  next usable value replaces it;
- object join: no first snapshot until every request is usable;
- a regular reactive field changing during pending is not copied early;
- multiple fields become usable in different orders without a mixed snapshot;
- error, syncing, and schema mismatch retain the last complete snapshot;
- no prior snapshot collapses every unavailable reason to pending;
- valid authored `undefined` initializes and survives reload;
- pending-first initialization makes a first valid `undefined` present rather
  than `NotFound`;
- schema projection excludes values not materialized by the injected schema;
- scope, CFC labels, durable reload, and no-op writes match ordinary derived
  output behavior.
- a cold resume never overwrites a durable complete snapshot with transient
  pending while the result target is still loading;
- the prior-output presence probe creates neither a self-trigger loop nor
  prior-snapshot CFC feedback.

**L2 exit:** `latestComplete()` advances only by whole usable snapshots and
retains the same persisted value through every incomplete interval.

## L3 — Documentation And Validation

- Document the contrast:
  - `resultOf(request)` is stateless and propagates current unavailability;
  - `latestComplete(input)` waits initially, then retains its last complete
    snapshot.
- Add one single-request example and one multi-request atomic join example.
- Run transformer emitted-output inspection plus API, transformer,
  schema-generator, and runner package tests.

Validation:

```sh
deno task check-docs specs
deno task --cwd packages/api test
deno task --cwd packages/ts-transformers test
deno task --cwd packages/schema-generator test
deno task --cwd packages/runner test
deno task check
```

L0 through L3 completed together with the DataUnavailable spec update. This
plan was then archived under `docs/history/plans/`.
