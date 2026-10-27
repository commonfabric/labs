# First-Class Serializable Factories

## Status

Proposed. This document specifies intended behavior, not the current
implementation.

The ordered execution checklist is
[First-Class Serializable Factories — Implementation Plan](../../plans/first-class-serializable-factories.md).

The content-addressed identity prerequisite is shipped: every verified,
module-scoped builder factory is addressable by `{ identity, symbol }`.
Exports use their export name, while transformed and non-exported factories use
their `__cfReg` name. See
[Content-Addressed Action Identity](../content-addressed-action-identity.md).

One prerequisite is not yet on `main`: generic `$patternRef` binding and direct
setup/sub-pattern resolution. The relevant semantic changes currently live in
the work behind #4514, including commits `3b028c786`, `39b213e63`, and
`ede6c5a7d`. This feature must copy or reimplement that small behavior and its
tests as Stage 0. It must not wait for, or import the unrelated reactive-
interpreter work in that PR.

This is an independent pattern-construction track. It does not depend on graph
snapshots or the reactive-interpreter migration.

## Summary

Every builder factory gets the same internal factory protocol, and every
factory with a cold-resolvable content-addressed artifact ref becomes a durable
first-class `FabricValue`:

- `PatternFactory` returned by `pattern`;
- `ModuleFactory` returned by `lift`, `byRef`, and other node-factory builders;
  and
- `HandlerFactory` returned by `handler`.

The callable function itself carries an internal Fabric-factory brand and
codec-state accessor. It serializes as `Factory@1` and decodes to a callable,
reference-backed factory shell. There is no `FabricPatternFactory` or
`NodeFactory` wrapper object. Arbitrary JavaScript functions remain invalid
`FabricValue`s.

Patterns additionally gain lexical closure conversion. A nested authored
`pattern(...)` is hoisted to module scope. Its callback receives public input as
argument 0 and its captured environment as compiler-generated argument 1. At
the authored site, the transformer calls an internal, one-shot
`.curry(params)` method on the hoisted factory.

That method is not public API. It always binds callback argument 1, takes no
argument index, and throws if called twice. It never binds, merges, removes, or
overrides fields in the pattern's public input. Authors express another layer
of partial application by defining another inline pattern closure, just as
they would curry a JavaScript function by defining another closure.

This representation replaces `patternTool` and its `{ pattern, extraParams }`
protocol. An inline pattern closes over the values to bind, and the resulting
`PatternFactory` is itself the tool value.

## Terminology

- **Factory**: a callable builder value of kind `pattern`, `module`, or
  `handler`.
- **Base factory**: the trusted module-scoped artifact identified by a content-
  addressed factory ref.
- **Factory state**: the codec-visible, non-public essential state of a factory,
  including its ref, kind, schemas, modifiers, and optional pattern params.
- **Public input**: argument 0 of a pattern callback and the value supplied by a
  pattern caller.
- **Closure params**: the complete captured environment in compiler-generated
  pattern callback argument 1.
- **Bound pattern**: a derived `PatternFactory` whose hidden factory state
  contains closure params.
- **Symbolic factory**: a factory-valued pattern input or captured value that is
  represented by a reactive cell while the enclosing graph is built.

## Current State and Gaps

All three factory kinds are already callable function objects with useful
descriptor state:

- `PatternFactory.toEncodableForm()` emits `$patternRef`, `argumentSchema`, and
  `resultSchema` at the storage boundary.
- `ModuleFactory.toEncodableForm()` and `HandlerFactory.toEncodableForm()` emit
  module descriptors, using `$implRef` for addressable JavaScript
  implementations.
- `asScope()` and `PatternFactory.inSpace()` return derived callable factories.
- verified exports and `__cfReg` values already enter the generic artifact
  index, regardless of factory kind.

One factory kind carries that state without declaring it. `lift`'s declared
return type is its call signature alone — a bare function type, which is what
lets a generic implementation carry its caller's element type through the
builder (see `LiftFunction` in `base/api/index.ts`). The object it returns
is an ordinary `ModuleFactory` with the whole protocol on it, so everything this
document specifies about module factories holds for a lift's; only TypeScript
declines to name it. Code that needs the record rather than the call reaches it
through `isModule()`.

The existing `toEncodableForm()` path is a one-way conversion. The runtime's
artifact walk (`runtime/runner/src/encodable-form.ts`) replaces each factory
with inert plain data before the value reaches the data model, which has no
route to a function of its own. Generic reads do not recreate a callable
factory. Pattern-valued list builtins
and LLM tools compensate with bespoke `$patternRef` handling.

Serialization alone also does not make a symbolic factory callable. Pattern
inputs are non-callable reactive proxies. Calling a factory-valued input as
ordinary JavaScript therefore fails while constructing the outer graph. The
runner already permits a reactive `NodeRef.module`, but its dynamic-module arm
is unfinished. This proposal completes that path and adds type-directed call
lowering.

Pattern construction has two further limitations:

1. `pattern()` currently calls its callback with one symbolic root and only
   recognizes `argument` and `result` alias roots.
2. Nested-pattern hoisting is limited to special `*WithPattern` and
   `patternTool` shapes. There is no general lexical closure conversion for a
   pattern returned or passed as data.

## Goals

1. Let every content-addressed factory kind round-trip through cells, pieces,
   arrays, objects, CLI/FUSE boundaries, and cross-space links without losing
   its factory kind or callability.
2. Let patterns accept, return, store, and invoke factory values with ordinary
   call syntax.
3. Preserve nested-pattern lexical semantics by making captures explicit,
   reactive closure params.
4. Keep pattern public input completely separate from closure params.
5. Use the existing content-addressed artifact identity and resolution model.
6. Preserve schemas, CFC labels, scope, and pattern space-selection behavior.
7. Replace `patternTool` and the separate params-merging rules around it.
8. Keep transformed output, serialization, hashing, and equality deterministic.

## Non-goals

- Serializing arbitrary JavaScript functions or native lexical closures.
- Exposing `.curry()` or another partial-application API to authors.
- General positional currying or repeated currying.
- Narrowing a factory's public input schema by binding public fields.
- Executing factory implementation code during decode or property access.
- Making keyless, action-created, or host-pseudo-module factories durable. A
  cross-session factory needs a trusted content-addressed module ref; a
  session-only pseudo-ref has no cold reconstruction path.
- Putting tool descriptions, observation policy, or other LLM metadata in
  `Factory@1`.
- Depending on graph snapshots.

## Author-Facing Semantics

### Factories are values

Factory types are valid fields in pattern inputs and outputs and remain
invokable after storage or transport.

```ts
// Shown for illustration only.
interface ApplyInput {
  value: string;
  operation: PatternFactory<
    { value: string },
    { result: string }
  >;
}

const apply = pattern<ApplyInput>(({ value, operation }) => {
  return operation({ value });
});
```

The same applies to modules and handlers:

```ts
// Shown for illustration only.
interface FactoryInputs {
  value: string;
  transform: ModuleFactory<{ value: string }, { length: number }>;
  select: HandlerFactory<{ id: string }, { source: string }>;
}

const useFactories = pattern<FactoryInputs>(({
  value,
  transform,
  select,
}) => ({
  transformed: transform({ value }),
  onSelect: select({ source: value }),
}));
```

Calling a received factory constructs a normal graph node. It does not execute
the referenced implementation synchronously and does not fetch source during
the call.

### Nested patterns close over values

Authors write ordinary lexical closures:

```ts
// Shown for illustration only.
const patternOne = pattern(({
  param2,
  otherPattern,
}: {
  param2: string;
  otherPattern: PatternFactory<
    { bar: string },
    { value: string }
  >;
}) => ({
  callback: pattern(({
    foo,
    bar,
  }: {
    foo: string;
    bar: string;
  }) => {
    const other = otherPattern({ bar });
    return { value: something(foo, param2, other.value) };
  }),
}));
```

The inner pattern's public input remains `{ foo, bar }`. `param2` and
`otherPattern` are closure params; they do not appear in, merge with, or
override the public input.

Captures may include reactive values, cells, plain `FabricValue`s, and any of
the three factory kinds. An arbitrary function value is never valid in closure
params, regardless of where it was declared. A module-scoped helper that the
hoisted callback references lexically is not a capture; it remains part of the
verified module.

### Inline patterns are the public partial-application model

Authors do not call `.curry()`. They define a wrapper pattern that closes over
the desired values:

```ts
// Shown for illustration only.
const makeIndex = pattern(({ entries }: { entries: Entry[] }) => ({
  search: pattern(({ query }: { query: string }) =>
    searchPattern({ query, entries })
  ),
}));
```

If another layer is useful, define another pattern. Each generated wrapper has
one environment and the original factory can itself be a closure param:

```ts
// Shown for illustration only.
const wrap = pattern(({
  operation,
  prefix,
}: {
  operation: PatternFactory<{ value: string }, { result: string }>;
  prefix: string;
}) => ({
  prefixed: pattern(({ value }: { value: string }) =>
    operation({ value: `${prefix}${value}` })
  ),
}));
```

This is the only author-facing currying model in version 1.

### Factory modifiers remain derivations

`asScope()` and `PatternFactory.inSpace()` continue returning new factories.
Their state is part of `Factory@1`, so modifiers survive storage. The raw
`inSpace()` selector is retained until graph construction; serializing a named,
anonymous, or cell-derived selector must not prematurely resolve it in the
writer's runtime.

For a pattern with closure params, modifiers may be applied before or after the
transformer-created binding. Every derivation preserves whether params are
already present, so no route permits a second internal curry.

## Branded Callable Fabric Protocol

### Direct factory branding

The factory function is the `FabricValue`. Trusted builder constructors attach
a non-enumerable internal brand and a state accessor. The exact symbol names
are internal; conceptually the dependency-free protocol is:

```ts
// Shown for illustration only.
const FABRIC_FACTORY = Symbol.for("common.fabricFactory");
const FACTORY_STATE = Symbol.for("common.factoryState");

interface FabricFactory {
  (...args: unknown[]): unknown;
  readonly [FABRIC_FACTORY]: true;
  readonly [FACTORY_STATE]: () => FactoryStateView;
}
```

The state accessor resolves through a stable internal root token because an
artifact ref is assigned after verified module evaluation. Curried, mapped,
and modifier-derived factories retain that same root token through a
`noteDerivedCopy`-equivalent side table; they never copy a temporarily missing
ref by value.

This requires a narrow extension to the current Fabric protocol. Today:

- `FabricValue` has no function arm;
- `[CODEC]` is class-side and lookup reads `value.constructor[CODEC]`;
- codec lookup rejects `typeof value === "function"` before class dispatch;
- native conversion only accepts functions through legacy `toJSON()`; and
- clone, freeze, equality, and hashing treat functions as invalid or primitive
  leaves.

Consequently, attaching today's `[CODEC]` property alone is not automatic. The
implementation adds a narrow `FabricFactory` arm plus one internal
`factoryStateOf(value)` / `tryFactoryState(value)` resolver. Conversion, JSON
encoding, deep-freeze, clone, equality, hashing, schema validation, and builder
traversal consult that resolver before their generic function branches. The
JSON registry has a dedicated callable-factory codec slot; it does not classify
`function` as an ordinary primitive type.

`FactoryCodec.canEncode()` accepts only values admitted to the internal
factory-state table. The brand is checked before legacy `toJSON()` conversion
and before generic function rejection.

No property on `Function` or `Function.prototype` is changed.

### Canonical state

All factory kinds use one wire tag and a genuinely discriminated essential
state:

```ts
// Shown for illustration only.
interface FactoryStateBaseV1 {
  ref: {
    identity: string;
    symbol: string;
  };
}

interface PatternFactoryStateV1 extends FactoryStateBaseV1 {
  kind: "pattern";
  argumentSchema: JSONSchema;
  resultSchema: JSONSchema;
  paramsSchema?: JSONSchema;
  params?: FabricPlainObject;
  defaultScope?: CellScope;
  spaceSelector?: FabricValue;
}

interface ModuleFactoryStateV1 extends FactoryStateBaseV1 {
  kind: "module";
  argumentSchema?: JSONSchema;
  resultSchema?: JSONSchema;
  defaultScope?: CellScope;
}

interface HandlerFactoryStateV1 extends FactoryStateBaseV1 {
  kind: "handler";
  contextSchema?: JSONSchema;
  eventSchema?: JSONSchema;
}

type FactoryStateV1 =
  | PatternFactoryStateV1
  | ModuleFactoryStateV1
  | HandlerFactoryStateV1;

// Internal only: refs may be pending and values may still contain
// Cells/Reactives that builder traversal must rewrite to aliases.
type LiveFactoryState = {
  kind: FactoryStateV1["kind"];
  rootToken: object;
  ref?: FactoryStateBaseV1["ref"];
  params?: FactoryInput<Record<string, unknown>>;
  spaceSelector?: FactoryInput<unknown>;
  // ...the kind-specific schema and modifier fields above
};

type FactoryStateView = LiveFactoryState | FactoryStateV1;
```

`LiveFactoryState` is not yet a hashable or encodable `FabricValue`. During
graph construction, shared factory traversal maps Cells/Reactives to aliases
while preserving `rootToken`. After verified module registration, the first
Fabric boundary calls `sealFactoryState()`: it resolves the factory artifact
ref, validates and freezes the mapped state, and memoizes one immutable
`FactoryStateV1`. Encode, hash, equality, and Fabric deep-freeze fail if sealing
is attempted before the ref exists. Once sealed, the logical state and its hash
cannot change.

JavaScript hardening of the callable before registration does not imply Fabric
deep-frozenness; the side-table state is not canonical until sealing succeeds.

`module` covers `ModuleFactory`, including factories returned by `lift`,
`byRef`, raw/builtin builders, and equivalent helpers.

`FactoryStateV1.ref` always names the complete builder factory artifact, as
returned by `getArtifactEntryRef(factory)` through its root token. It is never
copied from `moduleToEncodableForm(...).$implRef`: that legacy ref names an
implementation-resolution record and may not recover the factory descriptor or
methods.

`params` is either absent or the complete value for callback argument 1. It is
never a map of public input overrides. `paramsSchema` is trusted only after it
matches compiler metadata on the resolved base artifact; a wire value cannot
grant its own callback shape.

| Factory state | `paramsSchema` | `params` |
| --- | --- | --- |
| Capture-free pattern | absent | absent |
| Hoisted closure-bearing base pattern | present | absent |
| Bound closure-bearing pattern | present | present exactly once |
| Module or handler | forbidden | forbidden |

The public `argumentSchema` and `resultSchema` never change when params are
bound. Handler construction retains the original public state and event
schemas as `contextSchema` and `eventSchema` before combining them into the
existing internal `{ $ctx, $event }` module `argumentSchema`.

The encoded shape is:

```jsonc
{
  "/Factory@1": {
    "kind": "pattern",
    "ref": {
      "identity": "<module-content-identity>",
      "symbol": "__cfPattern_1"
    },
    "argumentSchema": { "type": "object" },
    "resultSchema": { "type": "object" },
    "paramsSchema": { "type": "object" },
    "params": {
      "param2": "...",
      "otherPattern": { "/Factory@1": { "kind": "pattern" } }
    }
  }
}
```

The nested example is abbreviated; every nested factory carries its complete
state.

### Encoding and decoding

Encoding performs these checks:

1. The value is present in the module-private factory state table, having been
   created by a trusted builder or by `FactoryCodec.decode()`. A copied symbol
   property is insufficient.
2. For a live builder factory, the state kind matches its trusted builder kind.
   A decoded shell may be re-encoded as validated data but gains no executable
   trust.
3. The factory has a cold-resolvable, content-addressed artifact ref. A
   keyless/manual or `host:<n>` pseudo-module factory fails encoding rather
   than embedding executable source or writing a session-only ref.
4. Pattern params, modifier state, and schemas are valid `FabricValue`s and
   contain no cycles.

Decode validates the discriminant, ref, schemas, allowed fields, and
pattern-only fields, then creates a frozen branded function shell containing
the unresolved state. Decode never resolves or executes implementation code.

Generic JSON and memory decode currently run without a runner-aware
reconstruction context. Therefore generic decode cannot by itself manufacture
a live runner factory. The decoded shell is function-shaped, branded, and
round-trippable, but its call body throws "factory requires runner
materialization" and it does not claim the full behavioral
`PatternFactory`/`ModuleFactory`/`HandlerFactory` surface.

The runner owns one chokepoint:

```ts
// Shown for illustration only.
materializeFactory(value: FabricFactory, runtime: Runtime): BuilderFactory;
```

The hook returns an existing live builder factory or resolves the shell's
factory artifact ref, reconstructs the correct callable builder factory, and
reapplies params and modifiers. Sync and async forms may share this contract;
cold source loading uses the async form.

Every runner exposure path uses this chokepoint: schema-driven `asFactory`
reads, recursive Cell/query result materialization, graph binding and dynamic
module dispatch, and CLI/FUSE/tool adapters. Transformed symbolic invocation
may pass a cell to the same hook after resolving its value. Context-free
`fabricFromJsonValue()` remains the intentional shell-returning boundary.

Materialization returns another function, not a wrapper object, and preserves
the canonical codec state for reserialization.

### Immutability, cloning, equality, and hashing

Canonical factories are immutable functional values:

- Fabric deep-freeze first seals and recursively freezes codec state, then
  freezes the callable;
- `.curry()`, `asScope()`, and `inSpace()` create new factory functions;
- factory values are always-frozen logical atoms, like `FabricPrimitive`
  values, so both frozen and mutable clone requests return the same canonical
  factory rather than exposing mutable hidden state;
- equality compares canonical `Factory@1` state, not function identity or
  `Function.prototype.toString()`; and
- hashing uses the `Factory@1` tag plus the recursively hashed codec state, the
  same semantic path used for codec-backed `FabricInstance`s.

The JSON encoder must include branded functions in its codec cycle tracking.

### Traversal and binding

Closure params may contain cells and other factories. Keeping params private
does not make them opaque to the graph builder.

All Fabric-aware walks use the factory state accessor or a shared codec-state
visitor. Builder traversal, alias conversion, CFC inspection, deep freeze,
clone, equality, hashing, and serialization must not each invent a different
view of factory state.

When a parent pattern is built, traversal recursively maps `params` and
`spaceSelector`. Captured cells become normal aliases, captured factory state
recurses, and a derived branded factory is returned with the mapped hidden
state. No public or enumerable `curried` property is required.

## Pattern Closure Transformation

### Pre-construction params-schema carrier

`pattern()` invokes its callback eagerly, before the hoisted factory reaches
`__cfReg`. The params schema therefore cannot first appear on artifact
registration. Schema injection decorates the callback before calling
`pattern()`:

```ts
// Shown for illustration only.
__cfHelpers.withPatternParamsSchema(callback, paramsSchema)
```

This compiler-only helper records the schema in a private callback WeakMap (or
equivalent symbol protocol) and returns the callback. `pattern()` and
`patternFromFrame()` read it synchronously on entry, create the second symbolic
root with that schema, and then invoke `callback(argument, params)`. They copy
the same trusted schema into the base factory's internal state for registration
and cold resolution.

The helper is part of the first argument expression. It does not add a fourth
argument to `pattern()` and is not author-facing API. The public callback type
still has one parameter; an authored second parameter is rejected unless the
callback carries this compiler-created metadata.

### Logical transformation

For the nested pattern above, the transformer produces this logical shape:

```ts
// Shown for illustration only.
const __cfPattern_1 = pattern(
  __cfHelpers.withPatternParamsSchema(
    (
      { foo, bar },
      { param2, otherPattern },
    ) => {
      const other = otherPattern({ bar });
      return { value: something(foo, param2, other.value) };
    },
    paramsSchema,
  ),
  publicArgumentSchema,
  resultSchema,
);

const patternOne = pattern(({ param2, otherPattern }) => ({
  callback: __cfPattern_1.curry({ param2, otherPattern }),
}));
```

The shown `.curry()` is emitted JavaScript, not accepted authored API.

There is no fourth argument to `pattern()`. The call remains
`pattern(callback, argumentSchema, resultSchema)`. The compiler-generated
closure-param schema enters through the callback wrapper above and is then
retained on the hoisted artifact. It is not another public positional argument.

### Internal `.curry(params)` contract

The compiler-only method has exactly one argument and these rules:

1. It is available only on the internal factory type used by transformed code;
   the author-facing `PatternFactory` type does not declare it.
2. It always binds callback argument 1. There is no argument-index parameter.
3. The supplied record is the complete closure environment and must satisfy
   the trusted params schema.
4. It returns a new branded `PatternFactory` whose hidden state contains
   `params`.
5. It does not change the public TypeScript input type or public
   `argumentSchema`.
6. It throws if the factory already has params, even if the second value is
   equal or empty.
7. It throws if the base pattern has no compiler-declared params slot.

A capture-free nested pattern emits no curry call. It simply references the
hoisted factory.

### Separate symbolic roots

The internal pattern builder creates up to three roots:

- `argument`: public callback argument 0;
- `params`: compiler-generated callback argument 1; and
- `result`: the pattern result.

`params` has its own schema and alias form. It is not nested under the public
argument and is not persisted as user-editable piece input. At pattern
invocation, the runner validates public input against `argumentSchema` and
binds hidden factory params to the separate `params` root.

Each bound pattern invocation creates an immutable hidden params cell owned by
the invocation's result cell. It has a deterministic result-relative cause,
uses `paramsSchema`, is linked from result metadata under `params`, and carries
the normal back-link to `result` for resume and teardown.
Before child nodes instantiate, setup resolves the bound factory state's params
against the parent binding context, writes or links them into this cell while
preserving CFC labels, and supplies the cell to alias resolution.

The alias vocabulary gains `{ $alias: { cell: "params", path, ... } }`.
`unwrapOneLevelAndBindToDoc`, `sendValueToBinding`, and direct sub-pattern setup
accept that pseudo-root only when the invocation has a params cell. Nested
links resolve relative to their original parent before the hidden cell is
populated; cross-space links remain links rather than copied values. On resume,
the serialized bound `Factory@1` state repopulates the same params cell before
the graph starts. The cell is torn down with its owning result and is never
exposed as piece input.

An invocation of a closure-bearing base factory without bound params fails.
Supplying public fields with the same names as closure params has no special
meaning and creates no collision: the roots are distinct.

### Compiler pipeline

The transformation order is:

1. Validate that the nested builder call occurs in a transformable pattern-
   owned context.
2. Collect non-module lexical captures, including captured factory values.
3. Rewrite the callback to receive captures in argument 1.
4. Generate the public argument schema, result schema, and private params
   schema. Wrap the callback with `withPatternParamsSchema(callback, schema)`
   so `pattern()` receives the metadata before eager construction; do not add a
   fourth `pattern()` argument.
5. Hoist the capture-free base `pattern(...)` call to a deterministic
   `__cfPattern_N` declaration and register it through `__cfReg`.
6. Replace the authored site with `__cfPattern_N.curry(captures)`, or with the
   bare hoisted factory when there are no captures.
7. Apply normal reactive-variable cause assignment after the site rewrite.

Current array-callback lowering must use the same representation. For example,
`map` lowers to a `mapWithPattern` call receiving a bound PatternFactory; it no
longer passes closure params as a separate sibling argument. All pattern
closure values flow through the one internal `.curry(params)` operation.

### Diagnostics

Compilation or runtime fails clearly for:

- a non-portable captured function;
- a capture the schema generator cannot represent;
- missing or extra closure params;
- params that fail their trusted schema;
- a second internal curry;
- an internal curry on a capture-free pattern;
- an unresolved or kind-mismatched factory ref; and
- an untransformed attempt to invoke a symbolic factory proxy.

Generated names and capture-property order are deterministic.

## Factory Schemas and Symbolic Invocation

### Schema representation

The schema generator recognizes factory types before its generic callable and
callable-returning-cell logic. A factory-valued field uses a Common Fabric
extension such as:

```ts
// Shown for illustration only.
{
  asFactory: {
    kind: "pattern",
    argumentSchema: { /* ... */ },
    resultSchema: { /* ... */ },
  },
}
```

The `module` form uses `argumentSchema` / `resultSchema`. The `handler` form
uses `contextSchema` / `eventSchema`. A `HandlerFactory` must not be mistaken
for an `asCell: ["stream"]` merely because calling it returns a stream.

Version 1 requires the stored factory's canonical public schemas to equal the
call site's generated schemas after reference resolution and normalization.
Schema variance is deferred. The resolved trusted artifact is authoritative;
wire-carried schema hints never grant execution or CFC authority.

Schema-light factories may still be passed and stored. Before symbolically
invoking a `type: "ref"` module factory such as `byRef()`, resolution follows
the ref through `ModuleRegistry` and uses that trusted module's schemas.
Authored `lift` and `handler` calls retain transformer-injected public schemas
on their factory metadata. If no trusted concrete schemas are available after
resolution, symbolic invocation fails; the call site's schema is not promoted
to authority. Direct invocation of the original live factory keeps its current
behavior.

### Type-directed call lowering

Calls on imported or module-scoped live factories continue using the existing
direct builder call path. Calls whose callee is a symbolic/reactive factory are
lowered to an internal builder helper:

```ts
// Shown for illustration only.
operation({ value })

// Logical lowered form:
__cfHelpers.invokeFactory(
  operation,
  { value },
  {
    kind: "pattern",
    argumentSchema,
    resultSchema,
  },
);
```

The helper records a dynamic node whose module input is the symbolic factory.
It returns a `Reactive` output for pattern/module factories and a `Stream` for
handler factories. Handler application retains its existing `$ctx` and
`$event` node wiring.

The type-directed detector follows local aliases, property access, and
statically typed element access, so `const f = inputs.factory; f(value)` and
`inputs.factories[key](value)` use the same lowering. Version 1 rejects a
callable union spanning factory kinds, because the builder must choose
`Reactive` versus `Stream` before runtime resolution. Same-kind unions are
allowed only when their normalized public schemas agree.

At instantiation, the runner reads the Factory value, validates kind and
schemas, resolves the trusted base artifact, applies modifier and pattern-param
state, and tail-calls the existing pattern, JavaScript-module, or handler
instantiation path. It does not call code during value resolution.

The dynamic node is a supervisor for one materialized child/action/handler. It
owns that instance's cancellation scope, result-owned internal cells, and
handler subscription. The factory cell is a reactive dependency. On change,
the supervisor:

1. increments a generation token and cancels the prior instance;
2. fences late async writes/results from older generations;
3. tears down the prior child internals and stream subscription while retaining
   the call site's output binding;
4. resolves and validates the replacement, including cross-space modifiers;
   and
5. instantiates the replacement under the new generation.

The stable output spot remains the cause/identity anchor, matching existing
sub-pattern and list-builtin invariants. The factory ref is a reactive
dependency and dispatch fingerprint, not an input to result-cell identity;
changing a factory must not churn the output cell merely because its program
changed. Distinct call sites already have distinct output bindings.

## Resolution

Warm resolution uses the existing generic artifact index:

```text
factory.ref -> trusted builder artifact -> verify kind -> instantiate
```

Cold resolution generalizes the existing pattern-only loader:

1. Load the source document for `ref.identity`.
2. Verify and evaluate the content-addressed module.
3. Resolve `ref.symbol` through exports or `__cfReg`.
4. Require a trusted builder brand and the expected factory kind.
5. Cache the artifact in the generic identity index.

This generalized `loadArtifactByIdentity()` path serves pattern, module, and
handler factories. A legacy `$patternRef` may adapt to a pattern
`FactoryStateV1` because it names the pattern factory artifact.

A legacy `$implRef` does not feed this resolver as a factory ref. It may name
only an implementation function and omits module/handler configuration. Its
compatibility reader retains the surrounding serialized module descriptor,
resolves the implementation through the legacy path, and reconstructs a
ModuleFactory or HandlerFactory with the corresponding internal descriptor
constructor.

For a bound pattern, setup additionally:

1. validates `paramsSchema` against the trusted base metadata;
2. validates the complete `params` value;
3. binds it to the pattern's `params` alias root; and
4. traverses nested factory refs and cell links normally.

Scope and raw pattern space-selector state are applied after base resolution
and before node instantiation.

## Trust and Security

The Fabric-factory brand is a data-type brand, not executable trust. The
symbol routes protocol handling; membership in a module-private WeakMap or
WeakSet is the unforgeable brand.

There are two separate capabilities:

- the data-model factory-state table admits well-formed live factories and
  decoded shells for conversion and reserialization; and
- runner-owned provenance tables alone assign/resolve executable artifact refs
  for verified builder factories.

The data-model registration mechanism is not an execution-trust grant, even if
an internal materializer must call it to create a derived shell.

- Only trusted builder constructors and `FactoryCodec.decode()` create branded
  values.
- `FactoryCodec.canEncode()` additionally checks the internal builder/state
  brand; a user function with a copied symbol property is rejected.
- Decoded state resolves only through the trusted artifact index or verified
  source loading. It cannot supply implementation source.
- The resolved artifact kind, schemas, and compiler params schema must match
  the decoded state before invocation.
- CFC and alias traversal descend into params, so hiding params from the public
  object shape does not hide their labels or dependencies.
- A factory's schema, ref, description, or debug preview is never an authority
  grant.

### Framework-provided inputs

Inline wrappers preserve `FrameworkProvided` obligations transitively. They do
not turn a framework-provided input such as `sandboxId` into an ordinary
closure param or let an author bind it indirectly.

The compiler records trusted framework-provided paths for each base factory.
When a wrapper calls such a factory, it synthesizes those fields into the
wrapper's argument schema and callback binding, then forwards their aliases to
the inner factory node. The fields are system-facing inputs, not closure params:
the tool adapter strips them from the model-facing schema, injects them from
the wrapper tool instance's identity, and the synthetic forwarding path carries
that exact value to the ultimate call. Wrapper chains repeat the same
transitive forwarding.

Authored code may neither supply a literal for such a field nor capture a
chosen value and forward it. If a required system value or stable tool identity
is unavailable, invocation fails closed.

Closure conversion rejects a capture that attempts to freeze a
framework-provided field into `params`. Captured ordinary values remain graph
bindings from the enclosing pattern, not a second caller-input channel, and
there is no public curry API that can override framework-supplied fields.

## Replacing `patternTool`

The current shape:

```ts
// Shown for illustration only.
const tools = {
  search: patternTool(searchPattern, { entries }),
};
```

becomes an ordinary inline pattern closure:

```ts
// Shown for illustration only.
const tools = {
  search: pattern(({ query }: { query: string }) =>
    searchPattern({ query, entries })
  ),
};
```

The wrapper's public schema naturally contains only `query`. `entries` is a
closure param, not a public input that a tool adapter subtracts or merges.

A PatternFactory is directly usable as a tool. Optional description or
presentation metadata may remain in an ordinary tool metadata wrapper, but
there is no `extraParams` field:

```ts
// Shown for illustration only.
const tools = {
  search: {
    pattern: pattern(({ query }: { query: string }) =>
      searchPattern({ query, entries })
    ),
    description: "Search this index",
  },
};
```

Tool discovery reads the factory's public argument schema. Invocation follows
the same dynamic factory path as ordinary pattern composition.

## Compatibility and Migration

During the migration, readers accept:

- `Factory@1` values;
- legacy pattern `{ $patternRef, argumentSchema, resultSchema }` values where a
  PatternFactory is expected;
- legacy serialized module descriptors carrying `$implRef`; and
- legacy `{ pattern, extraParams, ...metadata }` tool definitions; and
- legacy `mapWithPattern` / `filterWithPattern` / `flatMapWithPattern` nodes
  carrying sibling `{ op, params }` inputs.

New writers emit `Factory@1`. Legacy `extraParams` keep their existing
tool-boundary merge and precedence rules only in the compatibility reader. They
are not exposed as `.curry()` and are not redefined as closure params.

During the same dual-read window, list builtins accept either the legacy
`op + params` shape or a new bound PatternFactory with no sibling params. The
transformer emits only the new shape, while the old public method overload and
stored-node reader remain until source usage is gone and stored graphs have
been migrated or explicitly wiped.

Migration proceeds by changing source callers to inline wrapper patterns. Once
stored-data and source-usage gates are satisfied, remove:

- `patternTool` and `PatternToolResult`;
- transformer callback-boundary, validation, and hoisting special cases for
  `patternTool`;
- LLM schema-format and invocation special cases for `extraParams`;
- legacy list-builtin overloads and sibling `params` readers; and
- factory-function `toJSON()` compatibility once all boundaries use the
  registered Factory codec.

Current behavior documents remain accurate until the implementation lands;
they are updated in the same implementation change, not preemptively by this
proposal.

## Delivery Order

### Stage 0: Extract generic pattern-ref binding

Copy or reimplement the small `$patternRef` binder/setup behavior currently
coupled to #4514. Cover patterns nested anywhere in bindings and direct
setup/sub-pattern resolution. Do not take a dependency on the reactive-
interpreter stack.

### Stage 1: Branded factory Fabric values

Add the narrow callable Fabric protocol, `Factory@1`, canonical factory state,
codec registration, conversion, clone/freeze/equality/hash behavior, and shared
factory-state traversal. Brand every trusted pattern/module/handler factory.

### Stage 2: Factory schemas and dynamic invocation

Generate `asFactory` schemas, lower symbolic calls, complete the runner's
dynamic-module arm, and generalize cold artifact loading across factory kinds.

### Stage 3: Pattern closure conversion

Add the second callback root, pre-construction
`withPatternParamsSchema(callback, schema)` carrier, deterministic hoisting,
one-shot internal `.curry(params)`, params binding, and the updated
`*WithPattern` lowering.

### Stage 4: Remove `patternTool`

Migrate source callers to inline wrapper patterns, dual-read stored legacy tool
values, then remove the API and transformer/runtime special cases once the
compatibility gate is met.

Each stage is independently testable and revertible.

## Implementation Areas

- `base/data-model`: FabricFactory type arm and brand,
  `FactoryCodec`, codec registry function dispatch, conversion, freeze/clone,
  equality/hash, JSON cycle tracking, and formal type declarations.
- `runtime/memory` and runner storage/update paths: treat branded factories as
  atomic codec values at storage boundaries, preserve them through patches and
  diffs, and reject unbranded functions.
- `base/api`: mirrored FabricFactory and `asFactory` schema declarations;
  keep `.curry` out of the public `PatternFactory` type.
- `runtime/runner/src/builder`: brand/state attachment for every factory,
  pre-construction callback params-schema metadata, pattern params root,
  internal curry derivation, symbolic invocation helper, modifier persistence,
  root-token provenance, and live-to-canonical protocol traversal.
- `runtime/runner`: params pseudo-alias types and binding functions, hidden
  params-cell metadata/lifecycle, dynamic-module supervision, generic artifact
  resolution/loading, runner materialization, and compatibility adapters.
- `base/schema-generator`: recognize all factory kinds before generic
  callable handling and emit public factory schemas.
- `base/ts-transformers`: capture analysis, nested-pattern closure rewrite,
  `withPatternParamsSchema` emission, deterministic hoisting, symbolic call
  lowering, framework-input threading, list callback lowering, and diagnostics.
- `base/llm`, CLI, FUSE, and schema formatting: consume Factory values
  directly and retain legacy reads during migration.
- pattern sources: replace `patternTool` with inline patterns.

## Validation Plan

### Fabric protocol

- Encode/decode/hash/equality/clone/freeze each factory kind.
- Round-trip factories nested in objects, arrays, cells, pieces, and other
  factory params.
- Round-trip through the memory client/server boundary, where decode has no
  runner reconstruction context, then materialize in a runner.
- Reject arbitrary functions, copied symbols, malformed states, cycles,
  keyless artifacts, kind mismatches, and schema mismatches.
- Reject encode/hash/deep-freeze before ref sealing and verify that a sealed
  factory's state and hash never change.
- Verify equal state hashes equally across independent module evaluations.
- Verify params and space selectors participate in traversal and hashing.

### Transformer

- Golden-test the exact two-parameter callback and
  `__cfPattern_N.curry(params)` site.
- Assert `withPatternParamsSchema(callback, schema)` is present before eager
  `pattern()` / `patternFromFrame()` construction.
- Assert there is no fourth `pattern()` argument, argument-index curry, public
  input merging, or curry call for capture-free patterns.
- Capture cells, nested properties, and every factory kind.
- Reject non-portable functions and a second internal curry.
- Wrap a bound pattern in another authored pattern and verify one curry per
  wrapper.
- Lower symbolic factory inputs without changing imported/live-factory calls.
- Cover aliased, property-selected, element-selected, and same-kind union
  callees; reject cross-kind callable unions.
- Lower `map`/`filter`/`flatMap` captures through a bound PatternFactory rather
  than a sibling params object.

### Runtime

- Invoke stored pattern, module, and handler factories through symbolic inputs.
- Change a factory-valued cell and verify teardown/re-instantiation.
- Bind closure params through the separate params root and preserve public
  argument fields with the same names.
- Resume and tear down the deterministic hidden params cell, including nested
  aliases, cross-space links, and CFC labels.
- Capture and invoke another stored factory from a nested pattern.
- Verify Factory state uses the builder artifact ref, never an implementation
  `$implRef`, and exercise schema-light `byRef()` resolution.
- Preserve `asScope()` and every `inSpace()` selector form across round-trip.
- Resume all factory kinds cold by content-addressed identity.
- Preserve CFC labels and fail closed on forged refs or metadata.

### Tool migration

- Use an inline pattern that captures entries as an LLM tool.
- Wrap a tool with a framework-provided `sandboxId`; verify synthetic forwarding
  from the wrapper tool identity and reject authored/captured values.
- Discover and invoke the same tool through runtime, CLI, and FUSE paths.
- Read legacy `PatternToolResult` values without changing their old precedence.
- Read legacy list nodes with sibling params and emit only bound-factory nodes.
- Verify no new source caller or stored writer emits `extraParams`.

## Completion Criteria

This proposal is complete when:

1. Every content-addressed pattern/module/handler factory is directly branded
   and round-trips through a runner as a callable `Factory@1` value; keyless and
   session-only factories fail durable encoding.
2. Arbitrary functions remain rejected.
3. Factory-valued pattern inputs and captures invoke through one dynamic path.
4. Nested patterns preserve lexical semantics through callback argument 1 and
   exactly one transformer-only `.curry(params)` operation.
5. Public pattern inputs are never merged with closure params.
6. Factory refs, schemas, params, scopes, space selectors, CFC labels, and
   hashes survive storage and cold reload.
7. `patternTool` and sibling list params have no source writer path, and their
   compatibility readers have explicit stored-data removal gates.
