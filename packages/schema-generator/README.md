# @commonfabric/schema-generator

Short notes on the JSON Schema generator and ref/definitions behavior. The
canonical behavior reference is the mapping spec:
`docs/specs/schema-generator/ts_to_json_schema_mapping.md`; see also `AGENTS.md`
for the working guide.

## All‑Named Hoisting (default)

- Hoists every named type into `$defs` and emits `#/$defs/...` refs for non‑root
  occurrences.
- Excludes wrapper spellings and native leaf types from hoisting (the real rule
  is broader than a short name list — see `getNamedTypeKey`
  (`src/type-utils.ts`) and `src/typescript/wrapper-names.ts`; it covers all
  cell-wrapper spellings including `Writable`/`OpaqueCell`/`SqliteDb`, the
  native-type table, and generic instantiations).
- Root types remain inline unless recursion forces promotion to a `$ref`;
  `$defs` is included only if at least one ref is emitted.
- Unaliased type-literal shapes and generic alias instantiations are inlined; a
  non-generic named alias of a literal shape IS hoisted under the alias name
  (aliasSymbol fallback).
- `$ref` may appear with Common Fabric extensions as siblings (e.g.
  `{ "$ref": "#/$defs/Foo", asCell: ["stream"] }`).

Rationale: Improves human readability and re‑use of complex shared shapes while
keeping wrapper semantics explicit and simple.

Implementation: see `src/schema-generator.ts` (`formatType`) and
`src/type-utils.ts` (`getNamedTypeKey` filtering).

## Native Type Schemas

- Maps ECMAScript built-ins directly when they appear as properties:
  - `Date` → `{ type: "string", format: "date-time" }`
  - `URL` → `{ type: "string", format: "uri" }`
  - Typed array family (`Uint8Array`, `Uint8ClampedArray`, `Int8Array`,
    `Uint16Array`, `Int16Array`, `Uint32Array`, `Int32Array`, `Float32Array`,
    `Float64Array`, `BigInt64Array`, `BigUint64Array`) plus `ArrayBuffer`,
    `ArrayBufferLike`, `SharedArrayBuffer`, and `ArrayBufferView` → `true`
    (permissive JSON Schema leaf)
- These shortcuts keep schemas inline without emitting `$ref` definitions, while
  avoiding conflicts with array detection or hoisting, even when the compiler
  widens them via intersections or aliases.

## Function Properties

- Properties whose resolved type is callable or constructable are skipped
  entirely so we do not emit function shapes in JSON Schema output — except a
  callable whose call signature returns `Stream`/`Cell`/`SqliteDb`, which is
  kept as its `asCell` wrapper schema, participates in `required`, and carries
  the property's JSDoc description and lowered tags like any kept property.
- Method signatures, declared methods, and other properties whose type exposes
  call signatures are filtered before we decide on `required` membership or emit
  attribute metadata (docs, default wrappers, etc.).
- This keeps schemas focused on serializable data: JSON Schema cannot describe
  runtime function values, and downstream tooling expects objects, arrays, and
  primitives only.

Implementation: see `src/formatters/object-formatter.ts` and
`src/type-utils.ts:isFunctionLike`.

## Availability Marker Union Arms

When a TypeScript union includes a Common Fabric availability marker, such as
`AsyncResult<string>`, the marker arm is emitted as the native schema
`{ "type": "FabricUnavailable" }`. This recognizes the canonical primitive, not
an arbitrary object with matching fields. Common Fabric declaration provenance
distinguishes these types from unrelated local same-named types.

At runner compute boundaries, availability preflight runs before schema
traversal. The serialized exact-path input policy decides which reasons and
error kinds the computation can observe. Native schema admission alone does not
authorize observation. Accepted primitives remain intact through the lazy schema
view while surrounding usable data retains its ordinary validation.

## Running

- Check typings: `deno task check`
- Run tests: `deno task test`
