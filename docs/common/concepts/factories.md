# First-Class Factories

`pattern()`, `lift()`, and `handler()` return callable factory values. A
module-scoped factory is also a serializable Fabric value when the compiler can
give it a content-addressed artifact identity. It can be passed through pattern
inputs, returned from patterns, stored in cells or pieces, and loaded again
without introducing a wrapper class.

The public types are `PatternFactory`, `ModuleFactory`, and `HandlerFactory`.
Ordinary JavaScript functions are not serializable Fabric values.

Factory slots require a constructed factory, not a plain arrow function. Wrap
the callback in the matching `pattern(...)`, `lift(...)`, or `handler(...)`
builder so the compiler can attach its serializable artifact and schemas.

## Passing and invoking factories

Use the factory's normal call syntax. If the callee comes from a pattern input,
cell, property, or array element, the transformer lowers the call to a reactive
factory node. Replacing that value tears down the previous generation while
retaining the call site's output identity.

```tsx
import { ModuleFactory, pattern } from "commonfabric";

interface Input {
  value: number;
  transform: ModuleFactory<{ value: number }, number>;
}

export default pattern<Input>(({ value, transform }) => ({
  result: transform({ value }),
}));
```

The same value passed to a `lift` or `handler` callback arrives as an ordinary
materialized callable. If its code is cold, the runner delays only that
consumer until the artifact is ready.

## Returning and storing factories

Factory types may appear in input and output schemas and inside arrays and
objects:

```tsx
import { handler, HandlerFactory, pattern, Writable } from "commonfabric";

const append = handler<{ text: string }, { rows: Writable<string[]> }>(
  ({ text }, { rows }) => rows.push(text),
);

export interface Output {
  appendFactory: HandlerFactory<
    { text: string },
    { rows: Writable<string[]> }
  >;
}

export default pattern<{}, Output>(() => ({ appendFactory: append }));
```

Canonical Fabric storage encodes the value as `Factory@1`. Context-free decode
produces an inert callable shell; only a runner may materialize it into
executable code. A factory must have a durable compiler artifact ref before it
can cross a durable boundary.

When a factory is copied by value into another space, the runner publishes its
verified content-addressed source closure with the containing write. Warm
closures preserve synchronous speculative visibility; a cold closure delays
only ordered server submission, not the authored setter or local commit.
Cells and links remain opaque aliases rather than snapshots of their current
factory value.

Factory derivations survive the same trip. In particular, `asScope()` and the
complete `inSpace()` placement — its selector, grants, root reservation, space
kind, and self-ownership request — are reapplied when the runner materializes a
stored pattern factory.

## Inline pattern closures

An inline pattern may capture values from its surrounding pattern:

```tsx
// Shown for illustration only.
const searchTool = pattern(({ query }: { query: string }) =>
  searchIndex({ query, entries })
);
```

`query` is public input. `entries` is private closure state. The transformer
keeps them separate: public input is callback argument 0 and generated closure
params are callback argument 1. They are never merged, even if both contain the
same field name.

The transformed code uses `withPatternParamsSchema(callback, schema)` and a
private one-shot `.curry(params)` operation. `.curry` is transformer-only: it is
not in the public API, takes exactly one argument, and cannot bind twice. To add
another layer of partial application, write another inline pattern closure.

Reactive `map`, `filter`, and `flatMap` callbacks use the same mechanism. New
lowering passes one bound pattern factory to `*WithPattern`; captured values are
not passed as sibling params.

## Tool values

A `PatternFactory` is directly usable as an LLM, CLI, or FUSE tool. Optional
metadata wraps the factory without changing its public input:

```tsx
// Shown for illustration only.
const tools = {
  direct: searchTool,
  described: {
    pattern: searchTool,
    description: "Search the current index",
  },
};
```

`patternTool` and the `extraParams` entry in LLM tool maps have been removed.
Put tool-specific state in an inline `pattern(...)` closure and pass the
resulting factory directly (or use the `{ pattern, description }` metadata
form above). Do not pass the captured values beside the factory.

Factory-slot types compare the complete public input contract. In particular,
`Default<>` is part of that contract: a factory declared with a bare
`Default<"">` input is narrower than a slot accepting arbitrary `string`.
Prefer the normal `string | Default<"">` spelling and make the factory and slot
input types agree exactly.

Mounted tools appear as `*.tool`. FUSE JSON projections use the tagged Fabric
codec, not function source, a legacy `toJSON()` graph, or an implementation
descriptor. CLI/FUSE help and argument parsing first materialize trusted
artifact metadata, omit `FrameworkProvided` paths, and inject those values from
the stable containing tool Cell identity at invocation.

## Trust boundary

Factory state contains the complete builder artifact ref, never `$implRef`.
`$implRef` is used only inside instantiated execution-module descriptors.
`FrameworkProvided` paths come from trusted compiler/artifact metadata and may
not be supplied by Factory state, authored input, or closure captures.
