# Adding type-argument → schema lowering for a builtin

Several Common Fabric builtins accept a TypeScript **type argument** that the
transformer lowers into a runtime JSON Schema, so the runtime receives a real
schema even though generics are otherwise erased. `toSchema<T>()` is the
user-facing version of this; `generateObject` and `lift` use it internally to
turn a result/IO type into a schema argument.

This doc shows how to give a new builtin the same treatment — e.g. so
`myBuiltin<Row>(args)` injects `toSchema<Row>()` as a runtime argument.

## The moving parts

1. **Runtime registry** —
   [`src/core/commonfabric-runtime-registry.ts`](../src/core/commonfabric-runtime-registry.ts).
   Every recognized export has an entry with a `category` and, for calls, a
   `callKind`. The transformer keys behavior off this. Add (or reuse) an entry
   for your export.

2. **`detectCallKind(node, checker)`** — resolves a call expression to its
   registry `callKind`. Use it to recognize your call site.

3. **Schema-injection helpers** —
   [`src/transformers/schema-injection.ts`](../src/transformers/schema-injection.ts):
   - `createToSchemaCall(context, typeNode)` — builds a `toSchema()` call
     expression from a `ts.TypeNode`.
   - `createSchemaCallWithRegistryTransfer(...)` — same, but transfers the
     resolved `ts.Type` into the `TypeRegistry` so later stages
     (`schema-generator.ts`) can emit the concrete JSON Schema. Use this when
     the type must survive into code generation (the usual case).
   - The first type argument is read with the `node.typeArguments?.[0]` pattern
     (see the `getFirstTypeArgument` helper).

4. **Schema generator** —
   [`src/transformers/schema-generator.ts`](../src/transformers/schema-generator.ts)
   walks the `TypeRegistry` entries created above and emits the final schema
   literals. You usually do **not** touch this — registry transfer wires it up.

## Recipe

To lower `myBuiltin<Row>(args)` into
`myBuiltin(args, /* injected */ toSchema<Row>())`:

1. **Register the export.** In `commonfabric-runtime-registry.ts`, add an entry:
   ```ts
   { exportName: "myBuiltin", category: "call", callKind: "runtime-call", reactiveOrigin: true }
   ```
   (Add a dedicated `callKind` only if you need call-site-specific handling
   beyond schema injection; `"runtime-call"` is usually enough.)

2. **Recognize the call** in `schema-injection.ts`'s visitor: guard on
   `detectCallKind(node, checker)` matching your export, and on
   `node.typeArguments?.length === 1`.

3. **Build and inject the schema argument:**
   ```ts
   const rowType = node.typeArguments![0];
   const schemaCall = createSchemaCallWithRegistryTransfer(
     context,
     rowType,
     checker,
   );
   // append (or splice) schemaCall into the call's argument list
   return ts.factory.updateCallExpression(
     node,
     node.expression,
     /* typeArguments */ undefined,
     [...node.arguments, schemaCall],
   );
   ```
   Drop the `typeArguments` on the emitted call (they've been lowered). Mirror
   the argument _position_ your runtime builtin expects.

4. **Read it at runtime.** The builtin's runner-side implementation receives the
   injected schema as a normal argument; use it like any other schema.

## Reference implementations

- **`toSchema<T>()`** — the canonical case. Search `toSchema` in
  `schema-injection.ts` (the `createToSchemaCall` definition and its call
  sites). The runtime stub that throws when the transformer didn't run is in
  [`packages/runner/src/builder/factory.ts`](../../runner/src/builder/factory.ts).
- **`generateObject` / `generateObjectStream` / `generate-object`** — both
  public forms share the dedicated call kind which injects a _result_ schema
  from a type argument; the closest analog to "result row" lowering. See the
  function-first argument-order handling
  (`[function, inputSchema, resultSchema]`) in `schema-injection.ts`.
- **`lift` / `lift-applied`** — input + result schema injection from two type
  arguments.
- **`sqliteQuery<Row>`** — the canonical _structured-result_ case: the branch
  injects the **bare** `Row` schema as a `rowSchema` property and the **runtime
  builtin** (not the transformer) applies it to the successful value's `rows`
  array, consumed as `resultOf(query).rows`. Use this as the model when the type
  argument describes a value nested inside the builtin's return shape. Keyed on
  `callKind.kind === "runtime-call" && exportName === "sqliteQuery"` (a
  `runtime-call` registry entry gets NO schema injection by itself — a dedicated
  branch is required). Fixtures: `sqlite-query-row-schema.{input,expected}` and
  `sqlite-query-no-type-arg.{input,expected}` (the untyped-call no-op guard).

## Tests

Add a fixture pair under [`test/fixtures/schema-transform/`](../test/fixtures/)
(or `ast-transform/` for full-pipeline cases): a `*.input.tsx` calling your
builtin with a type argument and a `*.expected.jsx` showing the injected
`toSchema`/ schema literal. The fixture-based test runner
([`test/fixture-based.test.ts`](../test/fixture-based.test.ts)) picks them up.
See `lift-explicit-toschema.{input,expected}` and
`pattern-with-types.{input,expected}` for the shape.
