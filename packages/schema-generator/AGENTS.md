# @commonfabric/schema-generator — Agent Guide

Converts TypeScript types to Common Fabric JSON Schemas (2020-12 dialect + repo
extensions). Consumed at compile time by `packages/ts-transformers`
(SchemaGeneratorTransformer constructs a `SchemaGenerator`); also the repo's
wrapper-type vocabulary oracle — ts-transformers imports `cell-brand`,
`common-fabric-symbols`, `default-brand`, `wrapper-names`, `property-name`,
`property-optionality`, `numeric-expression`, `type-node` via subpath exports.
Entry point is `src/index.ts` (not `mod.ts`).

## Where answers live

| Question                                                                 | Read                                                                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Full type→schema mapping rules                                           | `docs/specs/schema-generator/ts_to_json_schema_mapping.md` (sources-of-truth table first)                          |
| The runtime schema dialect (asCell, ifc, additionalProperties tri-state) | `docs/specs/json_schema.md` + the `JSONSchema` type in `packages/api/index.ts` (the type is authoritative)         |
| Wrapper vocabulary (spelling vs resolved kind)                           | `src/typescript/wrapper-names.ts` (header comment) + `src/typescript/cell-brand.ts`                                |
| Cross-package contract with ts-transformers                              | bare WeakMaps `typeRegistry` / `schemaHints` — see `packages/ts-transformers/src/core/cross-stage-state.ts` header |
| How the generator is structured                                          | `src/schema-generator.ts` (formatter chain) + `src/interface.ts` (GenerationContext)                               |

## Facts that will bite you

- Formatter chain order is behavior: CommonFabric → NativeType → Union →
  Intersection → Array → Primitive → Object (`src/schema-generator.ts`).
  CommonFabricFormatter owns wrapper types AND CFC alias→`ifc.*` lowering.
- Hoisting emits `$defs` / `#/$defs/...` (all named non-wrapper types; cycles
  get `AnonymousType_N`). Anything that says `definitions` is out of date.
- Wrapper markers are `asCell` ARRAY entries — `["cell"]`, `["stream"]`,
  `["opaque"]`, nested `["cell","cell"]`. There is no `asStream` field anymore.
- Semantic sentinels: `any` → `true`; `unknown` → `{ type: "unknown" }`; `never`
  → `false`; `void` → `{ asCell: ["opaque"] }`; `undefined` survives in unions
  (`{ type: "undefined" }`). The `unknown`/`undefined` type values are
  deliberate non-standard extensions, as are the `FabricPrimitive` type names
  (`{ type: "FabricBytes" }` and friends — each the `.schemaType` its class
  reports, listed at runtime by `FABRIC_PRIMITIVE_SCHEMA_TYPES` in
  `packages/data-model/src/fabric-primitives/impl.ts`), emitted for fields
  authored against those classes.
- Fail-loud inventory: `Map`/`Set`/`WeakMap`, `Cell<Stream<T>>`,
  `Default<undefined>`, unresolvable DeepDefault keys, and circular aliases
  THROW rather than degrade. An unformattable type also throws (complete
  formatter coverage is asserted).
- CFC alias recognition is NAME-keyed with no source-file check (unlike
  `Default`'s brand check) — a user type named e.g. `Integrity` will lower to
  `ifc` metadata. Known foot-gun; don't "fix" silently, it's load-bearing for
  api aliases.
- JSDoc flows into schemas: first doc → `description`, `#hashtags` → `tags`,
  conflicting docs → `$comment`. Declaration files are excluded.
- Two analysis paths — type-based and node-based (synthetic TypeNodes from
  ts-transformers, or `any`-widened types). They can encode literals differently
  (`const:` vs `enum:`); when output looks inconsistent, check which path ran
  (`shouldUseNodeBasedAnalysis`).

## Test workflow

`deno task check` and `deno task test`. The check task excludes raw fixture
inputs because the fixture runner supplies their synthetic wrapper prelude.
Golden fixtures support `UPDATE_GOLDENS=1`, single-fixture `FIXTURE=<name>`, and
`SKIP_INPUT_CHECK` (see `deno.jsonc` test task's env allowlist). End-to-end
emission is also pinned by ts-transformers fixtures (`schema-transform/`,
`schema-injection/` suites) — behavior changes here fail that package's goldens
too; run both.

## When you change behavior

Update the mapping spec in the same change (it is descriptive: code wins, spec
must follow). If you change wrapper vocabulary, `wrapper-names.ts`'s exhaustive
classification tables make every consumer site a compile error until it
classifies the new spelling — that's the intended workflow, not an obstacle.
