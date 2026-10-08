# schema-generator: TypeScript → JSON Schema Mapping (Current Behavior)

**Status:** Descriptive (current behavior; on conflict, code/tests win — §1)\
**Package:** `@commonfabric/schema-generator`\
**Last verified against:** origin/main `47ad2b898` plus this documentation and
test branch, 2026-07-16 verification\
**Related:** `docs/specs/ts-transformer/ts_transformers_current_behavior_spec.md`
(§10, §12 describe the consumer side; its §6.8/§12 CFC-lowering account was
corrected in the same 2026-07 audit that produced this document) and
`docs/specs/ts-transformer/README.md` (corpus map and authority rules).

## 1. Scope And Source Of Truth

This document specifies what the schema generator currently does, not what it
is intended to do. It covers the conversion of `ts.Type` / `ts.TypeNode`
inputs into `MutableJSONSchema` values; not schema validation, runtime schema
interpretation, or the transformer stages that decide *when* to generate.

Authoritative implementation sources:

- `packages/schema-generator/src/**`
- `packages/schema-generator/test/**` (fixtures under `test/fixtures/schema/`)
- the wrapper/extension vocabulary in `packages/api/index.ts` and
  `packages/api/cfc.ts`

If this document conflicts with code or passing tests, code/tests win.

Package exports (`deno.jsonc`): `.` → `src/index.ts` (no `mod.ts`), plus
eight subpaths — `./cell-brand`, `./common-fabric-symbols`, `./default-brand`,
`./wrapper-names`, `./property-optionality`, `./property-name`,
`./numeric-expression`, `./type-node`.
`src/index.ts` exports the `SchemaGenerator` class, the
`SchemaGenerationOptions`, `SchemaGenerationDiagnostic`, and
`WriterSourceIdentity` types, and re-exports `MutableJSONSchemaObj`.

Consumers, as of this writing (verified by import grep): the only external
consumer package is `@commonfabric/ts-transformers`, along two axes:

1. **Schema generation proper** — `SchemaGeneratorTransformer`
   (`packages/ts-transformers/src/transformers/schema-generator.ts`)
   constructs a `SchemaGenerator` and feeds it the pipeline's bare cross-stage
   maps `typeRegistry` / `schemaHints`
   (`ts-transformers/src/core/cross-stage-state.ts`; its header notes
   this package reads only the bare `WeakMap`s, not `CrossStageState`).
2. **Wrapper-vocabulary oracle** — ts-transformers imports the subpaths
   directly: `cell-brand` (call-root-support, cell-type, opaque-get-validation,
   helper-owned-expression), `default-brand` (type-shrinking), `wrapper-names`
   (cast-validation, type-shrinking, call-kind), `property-name`
   (reactive-keys, type-shrinking), `property-optionality` (`ast/utils.ts`),
   `type-node` (type-building, type-shrinking, schema-injection,
   cast-validation, pattern-context-validation, capability-analysis),
   `common-fabric-symbols` (type-building, type-shrinking, capability-analysis,
   cast-validation, assert-diagnostics, call-kind, dataflow). The
   `src/typescript/` tables are load-bearing for the whole transformer
   pipeline, not just schema output.

Instance state: `AnonymousType_N` naming lives on the `SchemaGenerator`
instance (`anonymousNames` WeakMap + counter, `src/schema-generator.ts`)
— numbering is stable per instance across successive `generateSchema` calls.

## 2. Generation Entry Points And Analysis-Path Selection

Two public methods on `SchemaGenerator` (`src/schema-generator.ts`):
`generateSchema(type, checker, typeNode?,
options?: SchemaGenerationOptions, schemaHints?, sourceFile?)` — the normal,
type-driven path — and `generateSchemaFromSyntheticTypeNode(typeNode, checker,
typeRegistry?, schemaHints?, sourceFile?, options?: SchemaGenerationOptions)`,
a thin wrapper that passes `checker.getAnyType()` as the type, forcing the
auto-detection below onto the node-based path.

**Path selection** (`shouldUseNodeBasedAnalysis`,
`src/schema-generator.ts`): node-based analysis is used iff a
`typeNode` is present, the resolved type has `TypeFlags.Any`, and the node is
*not* a wrapper reference (`detectWrapperViaNode`) — wrapper nodes stay on the
type path for `CommonFabricFormatter`. `formatChildType` re-runs
the detection per child and deliberately strips the parent's `typeNode` when
no child node is supplied to avoid mismatched type/node pairs.

The consumer adds a second trigger of its own: `SchemaGeneratorTransformer`
routes to `generateSchemaFromSyntheticTypeNode` when (a) the type arg is
synthetic (`pos === -1 && end === -1`) and resolved to `any`, or (b) the
type arg, synthetic or not, *contains* an `any`/`unknown` keyword anywhere
(`containsAnyOrUnknownTypeNode`), "so the checker does not recover a wider
semantic type" (`ts-transformers/src/transformers/schema-generator.ts`). Both
triggers are documented in the ts-transformers behavior spec §12.

**Printed nodes.** A caller passes `printedFrom` in `SchemaGenerationOptions`:
for a node it printed from a type, that type. The generator never reads such a
node as a node. At the root, in `formatChildType`, and on entry to the
node-based analyzer, a printed node gives way to the caller's own type at that
position when that type carries something, and to the type the node was
printed from when the caller's is `any`, `unknown`, or an unbound type
parameter. The schema hints attached to the node still apply, through the
context's `hintsNode`. A printed member of a type literal the caller built reads
as the property would in the object type the literal stands for: a callable is
left out, unless calling it makes a stream, a cell, or a database, which reads
as that wrapper's `asCell`, with the UI contract hint the member carries.

A print can carry syntax its type does not: in place of printing a type, the
checker writes a member's own annotation where it denotes the member's type,
and an alias by its name. For CFC labels, whose bindings live only in syntax,
the type path reads both, as §11 says, so a label a print carried is read
from its type.

**The node-based analyzer** (`analyzeTypeNodeStructure`,
`src/schema-generator.ts`) handles: `TypeLiteral` nodes (properties
with `questionToken` optionality; string/number index signatures →
`additionalProperties`, first non-undefined wins, no JSDoc),
`readonly` type-operator nodes (analyze the wrapped type), parenthesized
nodes (unwrapped), `ArrayTypeNode`, tuples (an array of the element union,
`undefined` admitted for an optional element, a rest element contributing
what lies behind it: a spread tuple's elements, each member's for a union of
tuples, else an array's items read through a reference — the same lossy
form as the type path), intersections (reduced as the checker reduces the
types, then merged as `IntersectionFormatter` merges them; the rules are
below), unions (`true` member short-circuits, `false` members filtered,
formatted arms deduplicated by value-model equality, singletons unwrapped),
literal nodes, `TypeReference` nodes (wrapper
detection first; then the default library's generic aliases — `Readonly`,
`Partial`, `Required`, `Pick`, `Omit`, `NonNullable`, `Array`,
`ReadonlyArray`, `Record` — applied structurally to their arguments when the
name binds through the node or, for an unbindable synthetic reference,
resolves lexically (`checker.resolveName`) to a library declaration, so an
authored or imported shadow of the name keeps the general path; then an
alias whose whole body is one of its own type parameters
(`type Reactive<T> = T`), read as the argument the reference supplies for that
parameter, since the reference denotes exactly that argument — except a scope
wrapper, whose scope `CommonFabricFormatter` reads from the reference's name;
then the general path, which resolves the name the same way — bound through
the node, else lexically from the module's scope, an import followed to what
it imports — and formats the declared type, so a name the module declares,
exported or not, or imports is read. A plain generic declaration is read under
bindings for every required parameter, taken from the reference's written
arguments or preceding-parameter defaults (§4.1). A member the bindings cannot
read, such as an indexed access with no checker-created instantiation, remains
unread at that member; it does not discard the enclosing object's readable
shape. Missing required arguments and deferred conditional declarations remain
unread on this fallback path. `CommonFabricFormatter` lowers scope wrappers
from their own payload argument without resolving the wrapper's name (the
transformer prints a wrapper it builds as `__cfHelpers.PerUser<…>`, a name no
scope declares), and follows CFC alias chains under their bindings (§11). A
scope wrapper without a payload argument remains unread, including through an
alias. `Date` also has a by-name special case. Keyword types and a final
resolve-else-`true` fallback complete the node path.

A `true` from that fallback is a guess rather than a reading, and is recorded
as one (`uninterpretedTypeNodes`). A wrapper holding a resolved type recovers
the value from it; a guess nothing recovers reaches the generation root, which
reports it as the `schema-type:unread` warning (`unread-type-diagnostics.ts`),
one per schema, naming each unread type once. An authored `any`, or a name
declared as `any`, is a reading, not a guess, and is not reported; nor is a
guess inside an intersection that accepts nothing, which leaves nothing of it in
the schema. Reaching the nesting limit of a CFC alias chain instead reports
`cfc-schema:recursion-limit` as an error: the unread remainder could discard
policies, so compilation must refuse the schema.

An intersection node is settled the way the checker settles the type, each
constituent read through its reference, and what remains is merged as
`IntersectionFormatter` merges: identical constituents fold; `never` leaves
`false`; `any` makes the whole accept anything unless the constituents beside
it that are no union already contradict each other, which is as far as the
checker looks before `any` wins; otherwise a union constituent distributes
and every combination of arms is settled on its own; `unknown` is the
identity; an empty object part drops out and takes `null` and `undefined`
with it, as `T & {}` does; primitives are narrowed or found disjoint wherever
they sit, `"a" & string` being `"a"` and `string & number` nothing; `null` or
`undefined` beside an object or a cell leaves nothing; a cell among the
constituents is the value, the first cell's, with the cap any of them puts
on its handle, as the checker reads a value of intersected cells, so
`Cell<unknown> & { y: number }` is that cell; arrays merge into an array of
the intersection of their items; and a constituent that merge refuses — a
non-object, or one with an index signature, as an array beside an object
has — yields the same unsupported-pattern fallback the type path emits.
Object parts merge into one object, and a property several of them declare
is settled the same way from the schemas its declarations give it,
documented as the type path documents it (§9) and refused where its
declarations are in different scopes. The keywords JSDoc writes are set
aside while those schemas are settled, and an optional declaration admits
`undefined` beside one that requires the property. What a constituent states
besides which values it holds is set aside while the values are settled and
stated of what they settle to, as the type path reads it from the checker's
type: its scope and its default belong to the whole value, so two scopes
refuse the intersection, as a scope wrapper nested in another with no cell
between them, and defaults that differ leave none; its labels go on the
members of the result it declares, or on the whole result where it declares
all of them or none, and a union's labels go on the members any of its arms
declares. A keyword written beside a reference is read in place of the
definition's, through a chain of references. Where a schema alone no longer
says what its type was, the generation context records where it came from
(`schemaOrigins`): `void` lowers to the opaque marker `OpaqueCell<any>` also
lowers to, and reduces as `undefined` does beside another primitive
(`undefined & void` is `undefined`, `string & void` nothing), while the
wrapper is a cell, the value beside any other part; an unsupported-pattern
fallback keeps the
constituents behind it, so a nested or named intersection is reopened when
an enclosing one reduces it (`(string & Brand) & number` is nothing); and a
union whose arms fold to one schema — `void | OpaqueCell<any>`, or two
branded primitives with the same fallback — keeps every arm, so an
intersection reading the survivor still distributes over them (an arm
accepting nothing is no arm, and is neither counted nor kept). Schemas with
recorded union or intersection constituents are deduplicated by identity:
equal fallback schemas can hide disjoint source types, so separate folded
unions remain separate constraints in an enclosing intersection.

`readonly` marks mutability and contributes no JSON Schema keyword. A
synthetic `readonly T[]` therefore has the same schema as its wrapped `T[]`.
In particular, `readonly unknown[]` emits
`{ type: "array", items: { type: "unknown" } }`, preserving the element's
reference-only semantics. The synthetic readonly array cases in
`test/schema-generator.test.ts` cover unknown, string, and object elements.

A cell read of an object type prints as `Readonly<{…}>`, and the general
name-resolution path resolves that alias to its *uninstantiated* declared
type — a mapped type over an unbound parameter — which reads as an empty
object with every member dropped. The alias rules exist so such a read keeps
its declared members, `unknown` ones included. A mapped view is derived on
a copy of the definition its argument refers to; the shared `Foo` definition
other consumers read is untouched. `Partial<Foo>` and `Required<Foo>` map
over each arm's own keys and so distribute over a union, arm by arm; on an
array they map the elements, which count as optional: `Partial` admits
`undefined` into the items, `Required` removes it. `Required` reads its
argument node wherever the schema has already lost the optionality it acts
on: a union is viewed member by member, and a tuple's slots are read as the
checker reads them — spreads expanded, a spread over a union one
alternative per member (a tuple member keeping its slots, an array member
held in a rest slot), an optional slot that a required slot follows made
required with `undefined` in what it holds, and the library's `Readonly`,
`NonNullable`, `Required`, and `Partial` opened onto the slots they wrap,
`NonNullable` dropping a union's `null` and `undefined` members first,
classified by what each opens to (an alias, parentheses), and the last two
applied there; the wrappers distribute over a union, so a tuple beside an
object under them keeps its slots — aliases opened along the way, through
parentheses and `readonly`, a circular one only once. An optional or rest
slot then loses `undefined` while a required slot keeps it, authored or
normalized in, spread, wrapped, or in a union alike; a tuple the rules
cannot open that way (a generic alias) is treated as an array. `Pick` and `Omit` map
over `keyof T`, and the keys of a union are the keys every arm has, so
`Pick<A | B, K>` and `Omit<A | B, K>` are one object over the surface the
arms share: a property accepts what any arm's does and is required only
where every arm that names it requires it, so `Omit<A | B, "kind">` keeps
neither arm's own members and a `Pick` of correlated arms no longer pairs
their values. An index signature (`additionalProperties`, present — a
schema, `true`, or `false` for a `never`-valued one, which covers every key
just the same; a closed object carries none) covers every key: a key an arm
has only through one takes the signature's schema and casts no vote on
being required, and an `Omit` from a surface every arm covers that way
keeps just the signature, the named members dissolving into it as they do
in `keyof T`. A `Pick` naming a key some arm lacks, or a union with an
arm that is no object, keeps the general path. Unions these rules build —
a tuple's items, a shared property, a merged signature — fold equal arms by
value-model equality (`dedupeByValueEqual`), flatten a bare nested union,
and keep an `unknown` arm beside the others as a synthetic union does.
`NonNullable` removes `null` and `undefined` from a direct schema (to
`false`), an array-valued `type`, an `enum`'s values, a union's arms, or a
referenced definition. The synthetic alias, tuple, intersection, and
shadowing cases in `test/schema-generator.test.ts` pin all of this.

**Observed node/type divergence — literal encodings.** The node path emits
`const` (`{ type: "string", const: "x" }`); the type path emits
single-value `enum` (`{ type: "string", enum: ["x"] }`,
`src/formatters/primitive-formatter.ts`). Both spellings appear in
emitted schemas depending on the producing path. The distinction is pinned by
`test/literal-encoding-paths.test.ts`.

## 3. Formatter Chain

`formatType` dispatches to the first formatter whose `supportsType` returns
true, in this fixed order (`src/schema-generator.ts`):

1. `CommonFabricFormatter` — wrappers, scopes, Default, CFC aliases, wrapper
   unions
2. `NativeTypeFormatter` — built-in name table (§5.2)
3. `UnionFormatter`
4. `IntersectionFormatter` — declines cell-branded intersections
   (`intersection-formatter.ts`)
5. `ArrayFormatter` — deliberately before `PrimitiveFormatter` "to avoid
   Any-flag misrouting", per the comment on the array literal
6. `PrimitiveFormatter`
7. `ObjectFormatter` — also claims the TS `object` keyword via `typeToString`
   (`object-formatter.ts`)

Order matters: CommonFabric before Union (wrapper unions), Native before
Object (built-ins are object types), Array before Primitive. If no formatter
matches, generation throws (`src/schema-generator.ts`). Before
dispatch, a type parameter bound at the reading is formatted as its argument
(§4.1). `formatType` short-circuits other type parameters
(constraint → default → `{}`) and conditional types (`{}`).

## 4. Core Type Mappings

All rows verified against code; test/fixture status marked. "probe" = verified
by an ad-hoc generation run against this tree during spec drafting, not pinned
by any repo test.

| TypeScript input | Emitted schema | Source | Pinned by |
| --- | --- | --- | --- |
| `string` / `number` / `boolean` | `{ type: "string"/"number"/"boolean" }` | `primitive-formatter.ts` | many fixtures |
| String/number literal | `{ type: …, enum: [v] }` (type path); `{ type: …, const: v }` (node path) | `primitive-formatter.ts`; `schema-generator.ts` | divergence pinned by `test/literal-encoding-paths.test.ts` (unions diverge structurally: `enum` list vs `anyOf` of `const`s); runner validation treats both alike but `schemasEqualIgnoringWriterStamp` (deepEqual, `cfc/prepare.ts`) does not — a path flip defeats stored-schema reuse |
| Boolean literal | `{ type: "boolean", enum: [true/false] }` via `intrinsicName` | `primitive-formatter.ts` | boolean-literals test |
| `bigint` | `{ type: "integer" }` | `primitive-formatter.ts` | probe only |
| bigint literal (`42n`) | `{ type: "integer", enum: [Number(v)] }` — converted through `Number`, so precision above 2^53 would be lost | `primitive-formatter.ts` | probe only |
| Template literal type | `{ type: "string" }` | `primitive-formatter.ts` | probe only |
| `null` | `{ type: "null" }` | `primitive-formatter.ts` | fixtures |
| `undefined` | `{ type: "undefined" }` — non-standard, deliberate (`api/index.ts`) | `primitive-formatter.ts`; node `schema-generator.ts` | fixtures |
| `void` | `{ asCell: ["opaque"] }` ("matches anything, but we will not access the cell") | `primitive-formatter.ts`; node `schema-generator.ts` | void-type.test.ts ×3 |
| `never` | `false` (boolean schema); `never[]` → `items: false`; `false` members dropped from `anyOf` | `primitive-formatter.ts`; `array-formatter.ts`; `union-formatter.ts` | array-special-types |
| `any` | `true`; `any[]` → `items: true` | `primitive-formatter.ts`; `array-formatter.ts` | tests |
| `unknown` | `{ type: "unknown" }` — non-standard (`api/index.ts`); `unknown[]` → `items: { type: "unknown" }` | `primitive-formatter.ts`; `array-formatter.ts` | array-special-types |
| TS `object` keyword | `{ type: "object", additionalProperties: true }` | `object-formatter.ts` | probe only |
| Type parameter bound at the reading (§4.1) | its argument, retaining authored argument syntax and its declaration scope | `schema-generator.ts`; `type-parameter-bindings.ts` | `test/typescript/type-arguments.test.ts`; generic writer tests |
| Unbound type parameter | constraint if any, else default, else `{}` | `schema-generator.ts` | constraint reading: `test/typescript/type-arguments.test.ts`; the pipeline substitutes `unknown` nodes before generation (ts-transformers spec §10.5), so `{}` is the *local* behavior |
| Conditional type | `{}`; a deferred reading under bindings is reported as unread | `schema-generator.ts` | `test/typescript/type-arguments.test.ts` |
| `T[]` / `Array<T>` / `ReadonlyArray<T>` / aliases | `{ type: "array", items: <T> }`; node-first element detection, then Reference/typeArguments, then numeric index | `type-utils.ts`; `array-formatter.ts` | fixtures |
| Tuple (`[string, number]`) | `{ type: "array", items: <merged element union> }` — e.g. `items: { type: ["number","string"] }`. **No `prefixItems`, no length bounds**; positional structure is lost (numeric-index fallback, `type-utils.ts`; grep confirms `prefixItems` appears only in a comment) | `type-utils.ts` | `test/tuple-emission.test.ts` |
| Dictionary with both string and number index | treated as object map, not array | `type-utils.ts` | untested directly |
| Index signatures on objects | `additionalProperties: <value schema>`; string index takes precedence over number; JSDoc from index-signature declarations propagates (conflicts → keep first + `$comment`) | `object-formatter.ts`; node path `schema-generator.ts` (no JSDoc) | descriptions-index* fixtures |
| `Record<K,V>` with finite literal-union `K` | expands to concrete `properties` (checker-driven property enumeration) | via `ObjectFormatter`; fixture `record-union-keys` | record-mapped-types.test.ts |
| Functions / callables / constructables | property skipped entirely (not in `properties`, not in `required`) — **except** callable properties whose call signature returns `Stream`/`Cell`/`SqliteDb` (ModuleFactory/HandlerFactory shapes): kept as `{ asCell: ["stream"/"cell"/"sqlite"] }`, they participate in `required`, and they carry the property's JSDoc description and lowered tags (`deprecated` included) exactly like a kept data property. Generic members, including nested type literals, union/intersection arms and array elements, use their instantiated type or bound argument to classify callability | classification: `object-formatter.ts`; member paths: `object-formatter.ts`, `schema-generator.ts` (only those three kinds; capability cells like `ReadonlyCell` returns are *not* kept) | pattern-with-types fixtures; object-formatter.test.ts |
| `FabricPrimitive` class (`FabricBytes`, `FabricDurationDay`, `FabricDurationNsec`, `FabricEpochDay`, `FabricEpochNsec`, `FabricHash`, `FabricKeyPair`, `FabricRegExp`, `FabricUnavailable` carrying the `FabricPrimitive` brand) | `{ type: "<Name>" }` — the fabric-primitive schema vocabulary (§5.2); a leaf, not hoisted, matched by prototype at validation time | `native-type-formatter.ts` | fixture `fabric-special-object-brand`; end-to-end: ts-transformers `schema-transform/fabric-special-object-brand` |
| `FabricInstancePlus` nominal brand (`FABRIC_INSTANCE_PLUS_BRAND` in `packages/data-model/src/api.ts`, an interned `unique symbol`), which `FabricInstance` declares at `never` | property skipped entirely (not in `properties`, not in `required`) — a symbol-keyed member, which the generator skips as it skips every symbol-keyed member; a field typed as `FabricInstance` emits `{ type: "object", properties: {} }` | `shouldSkipInternalProperty`, `object-formatter.ts` | fixture `fabric-special-object-brand` |
| `FabricPrimitive` nominal brand (`FABRIC_PRIMITIVE_BRAND` in `packages/data-model/src/api.ts`, an interned `unique symbol`) on a type outside the fabric-primitive vocabulary | property skipped entirely (not in `properties`, not in `required`) — a symbol-keyed member, which the generator skips as it skips every symbol-keyed member; a field typed as the `FabricPrimitive` base still emits `{ type: "object", properties: {} }` | `shouldSkipInternalProperty`, `object-formatter.ts` | fixture `fabric-special-object-brand` |
| TS `enum` declaration | hoisted under the enum name with **no `type` key** (all-literal union path, §8): numeric → `$defs: { Color: { enum: [0,1,2] } }` + `$ref`; string → `$defs: { Mode: { enum: ["on","off"] } }` | union path `union-formatter.ts`; hoisting §5 | `test/enum-schema-rows.test.ts` |
| Single enum member type (`Mode.On`) | inline literal schema, e.g. `{ type: "string", enum: ["on"] }`; enum-member symbols are excluded from named-type hoisting so same-named members and unrelated named types cannot collide in `$defs` | `getNamedTypeKey`, `type-utils.ts`; pinned by `test/enum-member-hoisting.test.ts` | — |
| `SqliteDatabase` (the `SqliteDb` handle's value, carrying the `SQLITE_DB_BRAND` unique symbol) | the handle descriptor `{ id, tables, rev }` with `additionalProperties: true` (§5.2), hoisted under `SqliteDatabase`; the brand's own members describe nothing, so a structural schema would shape a handle read down to `{}` | `native-type-formatter.ts` | `test/schema/cell-type.test.ts`; end-to-end: ts-transformers `handler-schema/sqlite-db-handler-state`, `schema-injection/scoped-sqlite-factory` |
| `Date` / `URL` / typed arrays / etc. | native table, §5.2 | `native-type-formatter.ts` | date-types fixture, native-type tests |
| `Map`/`WeakMap`/`Set`/`WeakSet` | **throws** (§13) | `type-utils.ts` | `schema-generator.test.ts` |
| `Reactive<T>` | erases to `<T>`'s schema, **no marker** (§6.4) | — | `capability-wrapper-types.test.ts` |
| Wrappers / `Default` / scopes / CFC aliases | §6, §7, §10, §11 | — | — |

Fallback sentinel: a primitive-flagged type matching none of the branches emits
`{ type: "string", enum: ["unknown"] }` (`primitive-formatter.ts`) — a
silent, mis-typed sentinel; untested and believed unreachable in practice.

### 4.1 Generic declarations and their bindings

A generic member annotation names its declaration's own parameters, even when
the checker knows the enclosing instantiation. The generator therefore reads
plain interfaces, classes and type-alias bodies under
`GenerationContext.boundTypeParameters`. Each parameter declaration maps to a
`BoundTypeArgument`: its checker type, its authored node where one exists, and
the bindings of the scope where that node is written. A forwarded parameter
retains that argument and scope. A parameter default reads under the preceding
parameters. Inherited members use their base declaration's parameters, bound
through the heritage arguments. A nested instantiation binds its parameters
afresh. Merged interface declarations bind each declaration's parameter nodes
by position. A default introduced by a later declaration is available to the
whole interface, including a default referring to a preceding parameter.

A bound parameter reads as its argument. Structural member syntax retains those
bindings through object properties, literal index signatures, arrays, tuples,
unions and intersections, and through alias bodies such as `Array<T>`,
`ReadonlyArray<T>`, `Record<string, T>`, `[T]` and `T | null`. Optional properties
remain outside `required`. When the checker adds `undefined` for an optional
property, the declared bound value retains that alternative, including an
optional cell reference. A synthetic reference with no checker instantiation
reads that alternative from the member's optional flag. A bound value whose
schema carries CFC labels at its root, such as an optional
`Confidential<Node<T>, …>` member, takes no `undefined` alternative: its labels
stay on the property, because the runtime's policy merge refuses labels on one
`anyOf` branch whose siblings it cannot prove type-disjoint, and a labeled
`$ref` cannot be (`assertNoDivergentIfcBranches`,
`packages/runner/src/cfc/schema-merge.ts`). The property remains outside
`required`. Explicit `T | undefined` and optional tuple elements also retain
`undefined`.

Library key arguments also read their bindings: `Pick<T, K>` and `Omit<T, K>`
accept a `K` bound to a literal key union, and `Record<K, T>` accepts a bound
string or number index type. This keeps intersection aliases such as
`Omit<T, K> & Partial<Pick<T, K>>` readable without losing their enclosing
shape. Concrete template-literal types remain readable beside generic members;
an unrelated binding does not make such a type deferred.

`UnionFormatter` reads the types used for `Default` coverage and object-default
checks through the same bindings. A reference such as `Box<T>` is matched to
its own instantiation among the enclosing union's semantic members and their
type arguments, so an argument for a different `Box` reading cannot validate
its default. Union arguments and anonymous object members are compared under
their bindings; an anonymous object must have the same declaration identity
and matching member types. Default target and value reads also search the
enclosing checker instantiation, including flattened marker arguments. Default
coverage uses the authored target rather than a capture's narrowed observation;
fields omitted from an observation do not invalidate a full object default.
Compound full-object default coverage requires a checker-created instantiation;
a raw synthetic generic reference with only its declaration type cannot supply
that validation through syntax alone.
Literal default nodes also read bound parameters. With `T` bound to `number`,
`T | string | Default<string, "">` emits
`{ type: ["number", "string"], default: "" }`; `PerUser<T>` with `T` bound to
`string` emits `{ type: "string", scope: "user" }`. A default the instantiated
value does not cover throws under the ordinary rules of §7. These behaviors
are pinned by `test/typescript/type-arguments.test.ts` and the full pattern
pipeline's `test/generic-pattern-input.test.ts` in ts-transformers.

When an operator cannot be read structurally, an available checker
instantiation supplies its value. Without one, an indexed access, conditional,
`keyof` or mapped member over a parameter remains unread and is reported; the
surrounding shape stays readable. An operator that retains a writer carrier
but loses its binding syntax must report the unread authored writer (§11).
Checker-created instantiations with no authored argument nodes bind their
parameter types, including base declarations, so printed captures can retain
member defaults and scopes. Such an argument does not recover a writer's
`typeof` identity from its type.

The default library's mapped aliases bind declarations reached through their
arguments: `Readonly<Input<number>>` reads an `Input<T>` member with `T` as
`number`. A synthetic reference such as `Box<number>` resolves the name in the
module's scope and binds the declaration to its supplied argument. An authored
or imported alias shadowing a library name reads its own declaration. Synthetic
operators still need either structural rules or an available checker
instantiation; resolving a name alone cannot evaluate them.

## 5. Named-Type Hoisting, `$defs`, And Cycles

### 5.1 All-named policy

A generic reading's cycle identity is its declaration together with its
bindings, semantic instantiation and authored query origins. Its first reading
and recursive occurrence use the same identity. A nongeneric alias naming a
generic instantiation supplies that reading's name, so two aliases of different
arguments cannot share the underlying declaration's definition. Readings under
different arguments remain distinct; stable recursive readings share a `$ref`.
Default-library containers retain their concrete checker identity, so an
enclosing `Array<T>` binding cannot alias arrays of different nested element
types.

Every type with a usable name is hoisted into `$defs` and referenced by
`{ "$ref": "#/$defs/<Name>" }` at non-root occurrences
(`src/schema-generator.ts`). The emitted container key is `$defs` —
never `definitions` (0 of 73 expected fixtures contain a `definitions` key; 29
contain `$defs`, as of this writing); only the *internal* context field is
still named `definitions` (`interface.ts`), and the README's `definitions`
wording predates the migration.

Whether a type gets a name is decided by `getNamedTypeKey`
(`src/type-utils.ts`). The rule is structural plus two derived name
sets — not the short name list in the README. A type is *excluded* when any of
these holds:

- the type **node** names a wrapper: `Default`, `Cell`, `Writable`,
  `ReadonlyCell`, `WriteonlyCell`, `ComparableCell`, `OpaqueCell`, `Stream`,
  `SqliteDb` (name sets `CELL_LIKE_WRAPPER_NAMES` / `OPAQUE_WRAPPER_NAMES`;
  `Reactive` is *not* excluded on the node axis);
- the **aliasSymbol** is one of the above or `Reactive`;
- the name is compiler-internal (`__type`, `__object`) or absent — with an
  aliasSymbol fallback, so **non-generic aliases to type literals
  hoist under the alias name** (fixture `shared-type`: `type Shared = {…}` →
  `$defs.Shared` + two `$ref`s);
- the symbol is property/method/signature/function/type-parameter-like or an
  enum member;
- the name is `Array`/`ReadonlyArray`, a wrapper name by symbol, or in the
  `NativeTypeFormatter` table (§5.2);
- the type is a **generic alias instantiation** (`aliasTypeArguments` present:
  `Record<K,V>`, `Partial<T>`, `Box<T>`) — inlined, the bare name
  being meaningless without arguments;
- the type is a **generic interface/class instantiation** without an alias name
  (`typeParameters` + `typeArguments` on the reference target).

Apart from `getNamedTypeKey`, the generator gives no name to a type that is a
scope wrapper, by its alias chain or by its brand (`scopeOfScopeWrapper`,
§10): `type Rec = PerUser<Inner>` formats inline, as `PerUser<Inner>` does, so
the scope stays at the top level of the slot's own schema. A recursive one
around a value still needs a definition; it is written under the cycle's
synthetic name without its scope, and every reference to it carries the scope
beside the `$ref` (`{ $ref: "#/$defs/AnonymousType_1", scope: "user" }`), the
schema's root among them where the root is promoted to a reference to its
definition. One around a cell is a wrapper,
and a wrapper is never a cycle's entry: the cycle is found at the cell's
value, as for `Cell<T>`, and each reference is the capped handle inline
(`{ $ref: "#/$defs/AnonymousType_1", asCell: [{ kind: "cell", scope: "user"
}] }`, as `PerUser<Cell<T>>` written in place emits).

Everything else — interfaces, classes, named aliases, and TS enum declarations
— hoists under its bare symbol name. Enum members stay inline. There is no
source-file qualification and no collision disambiguation for other named
types on the `$defs` key: the first definition stored under a name wins; later
same-named types emit `$ref`s to it.

### 5.2 Native leaf table

`NATIVE_TYPE_SCHEMAS` (`src/formatters/native-type-formatter.ts`), as of
this writing: `VNode` →
`{ $ref: "https://commonfabric.org/schemas/vnode.json" }`; `Date`, `RegExp`,
and `Uint8Array` → `{ type: "object" }`; the nine `FabricPrimitive` classes
(`FabricBytes`, `FabricDurationDay`, `FabricDurationNsec`, `FabricEpochDay`,
`FabricEpochNsec`, `FabricHash`, `FabricKeyPair`, `FabricRegExp`,
`FabricUnavailable`) → `{ type: "<Name>" }`
(the `FabricPrimitive`
schema
vocabulary, each name being the `.schemaType` its class's instances report);
`URL` → `{ type: "string", format:
"uri" }`; `ArrayBuffer`/`ArrayBufferLike`/`SharedArrayBuffer`/
`ArrayBufferView`, the remaining ten typed arrays
(`Uint8ClampedArray` … `BigUint64Array`), and `JSONSchemaObj`/`JSONSchema` →
`true`.

The three mapped to `{ type: "object" }` are native TS types with a canonical
fabric form: a `Date` is stored as a `FabricEpochNsec`, a `RegExp` as a
`FabricRegExp`, and a `Uint8Array` as a `FabricBytes`. They deliberately do
NOT adopt the `FabricPrimitive` type names: a field authored against a native
TS type can hold a raw native value on the way into the fabric boundary, and
the `FabricPrimitive` types validate by prototype only. `"object"` accepts the
stored fabric form, so a value stored as one reads back intact — where
`{ type: "string" }` projects the read to `undefined`. `URL` is the exception
that stays a string, because it converts to a plain string rather than to a
`FabricPrimitive`.

A field authored against a `FabricPrimitive` class ITSELF (`blob: FabricBytes`)
emits that class's schema-vocabulary name, a leaf with no `properties`, no
`required`, and no `$defs` hoisting. Validation is by prototype: a value
matches the name it reports as `.schemaType`, which each class under
`packages/data-model/src/fabric-primitives/` supplies. The dialect side is
specified in `docs/specs/json_schema.md`.

`NativeTypeFormatter` also claims one type that is not in the name table: the
`SqliteDb` handle's readable value, recognized by the `SQLITE_DB_BRAND` unique
symbol its type carries (`declaresSqliteDbBrand`). It emits the handle
descriptor the SQLite spec defines
(`docs/specs/sqlite-builtin/01-api.md`) —
`{ type: "object", properties: { id: { type: "string" }, tables: { type: "object", additionalProperties: true }, rev: { type: "number" } }, additionalProperties: true }`.
The type's own members describe nothing (a nominal brand is a single symbol
key), so a structural schema would shape every read of a handle down to `{}`.
`tables` carries the author-declared table schemas, whose per-column `ifc`
labels are what a pattern reads to write a query, and `additionalProperties`
keeps the fields outside the descriptor (`scope`, `owner`) from being dropped.
Because the claim is by brand rather than by name, this one keeps its ordinary
`$defs` hoisting: every `SqliteDb` position emits
`$ref: "#/$defs/SqliteDatabase"` against one descriptor.

The remaining typed arrays and the buffer types map to `true` (accept
anything), which overclaims: none of them is representable as a `FabricValue`,
so a value of one of those types is rejected at the storage boundary rather
than stored. `true` is the status quo for them, not an endorsement.

Guard: the lib-declared subset (`LIB_DECLARED_NATIVE_TYPES` — `Date`
through `BigUint64Array`, and `RegExp`) is claimed only when declared in a default-lib or
`@types/node` file (`hasLibraryDeclaration`), so a user-defined
`interface Date {…}` is not swallowed. The `FabricPrimitive` names are claimed
only when the type carries the `FabricPrimitive` nominal brand
(`declaresFabricPrimitiveBrand`), and named-type hoisting
(`getNamedTypeKey`, `type-utils.ts`) classifies by the same test, so an
unrelated user type named e.g. `FabricBytes` keeps its structural schema AND
its normal `$defs` hoisting (fixture `fabric-primitive-name-collision`).
`VNode`/`JSONSchemaObj`/`JSONSchema`
have **no** such guard (untested collision). Native resolution also pierces
type-parameter constraints/defaults and intersection constituents
(`getNativeTypeSchema`, `type-utils.ts`) — where the `Map`/`Set`
rejections live (§15) — and is consulted from union members, intersections,
and object built-in lookup (`union-formatter.ts`;
`intersection-formatter.ts`; `object-formatter.ts`).

### 5.3 Root handling and pruning

Roots stay inline unless the root type already landed in `$defs` *and* was
referenced — then the document becomes `{ $defs: {…}, $ref: "#/$defs/<Root>" }`
(`shouldPromoteToRef`, `src/schema-generator.ts`; fixture
`recursion-basic`). `$defs` is attached only when at least one `$ref` was
emitted, pruned to the transitively referenced subset
(`collectReferencedDefinitions`; traversal skips nested
`$defs`/`definitions` blocks).

### 5.4 Cycles

Two mechanisms: `inProgressNames` — a named type being built emits an
immediate `$ref` on re-entry — and `definitionStack`
identity/stack-key detection, under which anonymous cyclic types
get synthetic `$defs` names `AnonymousType_N` (`ensureSyntheticName`; fixture
`writable-recursive-todoitem` shows `AnonymousType_1` and
the `$ref`-with-siblings shape `{ "$ref": "#/$defs/AnonymousType_1", "asCell":
["cell"], "default": [] }`).

A wrapper (`Default`, a cell, a scope wrapper around a cell) is not a cycle's
entry, because TypeScript reuses one type object for identical wrapper
instantiations at different positions, which would otherwise create false
cycles; the cycle is found at the wrapper's value instead (fixtures
`nested-default-aliases`, `default-array-recursive`). Nor is `never`, `null`
or `undefined`, none of which holds a type, or `unknown` or `any`, which hold
any, and so none is met inside itself. A wrapper the checker reduces to one has
it for its own type and for its payload's: `PerUser<never>` is
`never & brand`, which is `never`, and `PerUser<null>` is `null`, which
`Scoped` keeps outside the brand; its payload is read as the value it wraps
(§10), not as its recursion. So does a scope wrapper read from its node alone,
which is read at `unknown`, around `unknown`: `PerUser<unknown[]>` read that
way is `{ type: "array", items: { type: "unknown" }, scope: "user" }`.

**Dead computation (observed implementation note):** every run performs a full
DFS cycle pre-pass (`getCycles`, using `safe*` wrappers that
`console.warn` and continue) and stores `cyclicTypes`/`cyclicNames` on the
context (`interface.ts`) — but nothing reads either set
(grep over `src/` finds writes only). Pure startup cost; a removal candidate.

## 6. Wrapper Types And The `asCell` Vocabulary

### 6.1 Three axes

The wrapper vocabulary is deliberately split (header comment,
`src/typescript/wrapper-names.ts`):

- **Spelling axis** — `WrapperSpelling` (`wrapper-names.ts`): every name
  matched syntactically: `Cell`, `Writable`, `ReadonlyCell`, `WriteonlyCell`,
  `ComparableCell`, `OpaqueCell`, `Stream`, `SqliteDb`, `Reactive`,
  `CellTypeConstructor`, `ScopedCellTypeConstructor`.
  `WRAPPER_SPELLING_TO_KIND` normalizes spelling → kind — the
  `Writable` → `Cell` normalization lives here, once; the two
  constructor-interface spellings map to `undefined`. Membership sets derive
  from exhaustive `Record<WrapperSpelling, boolean>` tables
  (`spellingsWhere`), so a new spelling fails compilation at every
  classification site.
- **Resolved-kind axis** — `CellWrapperKind`
  (`src/typescript/cell-brand.ts`): `OpaqueCell | Cell | Stream |
  ComparableCell | ReadonlyCell | WriteonlyCell | SqliteDb | Reactive`.
- **Brand axis** — `CellBrand` (`cell-brand.ts`): the marker strings
  `"opaque" | "cell" | "stream" | "comparable" | "readonly" | "writeonly" |
  "sqlite"` that land in schemas.

Cell detection is **structural, not nominal**: brand marker properties
`CELL_BRAND`/`CELL_INNER_TYPE` (including `__@`-mangled and
computed-property-name declarations) are found via configurable hierarchy
traversal (apparent type, reference targets, base types —
`cell-brand.ts`, `type-traversal.ts`), memoized per
(checker, type) in a `TwoLevelWeakCache` (`cell-brand.ts`). Node-level
detection (`detectWrapperViaNode`/`resolveWrapperNode`,
`type-utils.ts`) reads a node through parentheses and follows alias chains
syntactically — local, imported, and namespace-qualified aliases, generic
ones included (`getTypeAliasDeclaration`, `src/typescript/type-node.ts`). The
node it resolves to is one whose type arguments are the wrapper's own at the
reference: the wrapper reference itself; the reference an alias declares,
where none of its type arguments mentions the alias's type parameters; or,
through an alias that passes its parameters to the wrapper unchanged and in
order (`type UserDefault<T, V> = Default<T, V>`), the reference as written.
An alias that does more with its parameters (`Default<T[], []>`,
`Default<string, V>`) leaves no such node, so its reference is not a wrapper
reference to node-level detection and is read from the type it instantiates
(§6.3); the chain is still followed, so a circular one throws. A cell
wrapper's
name counts only where it resolves, through its import binding, to the
wrapper `commonfabric` declares (`isCommonFabricSymbol`,
`src/typescript/common-fabric-symbols.ts`), under whatever name it was
imported as: a type of the author's own named `Writable` is not a cell. A
node the checker cannot resolve, as one ts-transformers synthesizes, is read
by its spelling, and `Default` is recognized by its spelling (§7).
**Circular alias chains throw** (`Circular type alias detected: A -> B ->
…`; a second detection in union alias resolution, `union-formatter.ts`; both
tested by `circular-alias-error.test.ts`). `wrapper-reference.test.ts` pins
the parentheses, the imported aliases, the identity rule, and both kinds of
generic alias.

### 6.2 Emission

`applyWrapperSemantics` (`common-fabric-formatter.ts`) maps the
resolved kind to a brand (`wrapperKindToBrand`, `cell-brand.ts`) and
**prepends** one entry to a single `asCell` array on the inner schema:
`Cell` (and the `Writable` spelling) → `"cell"`, `Stream` → `"stream"`,
`OpaqueCell` → `"opaque"`, `ReadonlyCell` → `"readonly"`, `WriteonlyCell` →
`"writeonly"`, `ComparableCell` → `"comparable"`, `SqliteDb` → `"sqlite"`.
Nesting prepends: `Stream<Cell<number>>` → `{ type: "number", asCell:
["stream", "cell"] }` (fixture `stream-of-cell-number`); `Stream<void>` →
`{ asCell: ["stream", "opaque"] }` (fixture `reactive-stream`, via `void` →
opaque). Boolean inner schemas: `true` → `{ asCell: [brand] }`; `false` →
`{ asCell: [brand], not: true }`.

Entry shapes (`packages/api/index.ts`): `AsCellEntry = CellKind |
{ kind: CellKind; scope?: SchemaScope }`, `CellKind` being the seven brand
strings. The object form is produced only by scope wrapping
(§10). `Cell<Cell<T>>` → `asCell: ["cell","cell"]` is representable per the
api comment (`api/index.ts`), but no fixture pins direct
cell-in-cell nesting as of this writing; the pinned nested pair is
`["stream","cell"]`.

**No `asStream` / `asOpaque` keys are ever emitted.** Grep over `src/` finds
them only in two stale comments; the api `JSONSchemaObj` has no such members.
The single-array cleanup landed in #3732 (2026-05-29, verified in git), also
the README's last commit. Legacy *readers* of `asStream` survive in
`packages/runner/src/` (`schema.ts`, `traverse.ts`, `link-utils.ts`, …) for
pre-cleanup schemas.

### 6.3 Node/type interplay

- A generic alias whose resolved type is a Cell or a `Default`, and that
  leaves no node carrying the wrapper's arguments (§6.1), uses that resolved
  wrapper's payload. The alias's own first argument need not be the payload;
  source type arguments supply an inner node only where they are the
  wrapper's own: direct wrapper syntax, and an alias that passes its
  parameters through.
  Non-generic aliases retain their resolved declaration node so payload
  defaults remain available to schema generation.
- Capability re-wrap fidelity: when a **synthetic** node narrows a capability
  brand (the transformer re-wraps `Cell<T>` as `ReadonlyCell<T>`), the node's
  own inner is read first, so that structure only the node carries — a shrunk
  shape, an `| undefined` member — reaches the schema. The resolved type's
  inner supplies the value schema instead in two cases. One is a bare named
  reference that degrades to `any`. The other is an inner holding a member
  that node-based analysis cannot read from a synthetic position, of which the
  printer produces two: `import("./mod.ts").T` for a name the emitting module
  does not import, and the `T & { readonly [DEFAULT_MARKER]: V }` arm of an
  expanded `Default`. An unreadable member can make a whole union accept
  anything, while an unreadable computed property name can drop brand metadata
  from an otherwise structured schema. Both mark the node-driven result as
  incomplete, so the resolved value supplies its shape and defaults. Both
  fallback cases apply only for capability kinds
  (`CELL_CAPABILITY_KIND_MAP`, `common-fabric-formatter.ts`: the five
  cell-capability kinds true; `Stream`/`SqliteDb`/`Reactive` false; exhaustive
  over `CellWrapperKind`), and only where a resolved wrapper type exists: a
  synthetic wrapper with no resolved type keeps the node-driven result.
  Non-synthetic disagreeing nodes defer to the semantic kind (tested:
  capability-wrapper-types "uses semantic wrapper kind…" / "allows registered
  synthetic wrapper nodes…" / "a synthetic node narrowing a resolved
  wrapper").
- Wrapper unions: a union whose non-null/undefined members are **all** wrappers
  formats member-wise, preserving `{ type: "undefined" }` / `{ type: "null" }`,
  skipping conditional/type-parameter members, deduping identical member
  schemas (`isWrapperUnion` / `formatWrapperUnion` / `maybeWrapInAnyOf`).
  Mixed unions fall to `UnionFormatter`. A wrapper that CFC labels hold, as
  `Confidential<Cell<T>, …>` does, is a labeled value rather than a wrapper
  here: a union holding one falls to `UnionFormatter`, which reads it through
  its CFC alias, so `Confidential<Cell<string>, ["b"]> | undefined` keeps
  `ifc` on the cell's alternative (tested: cfc-authoring "a labeled cell that
  may be missing", the runner's cfc-labeled-cell-input). Primitive alternatives merge only
  when both schemas contain exclusively `type` and `enum`; metadata-bearing
  alternatives, including Cell wrappers, remain separate even when their
  underlying primitive types match.
- `Cell<Stream<T>>` **throws** with a boxing suggestion, from both the node
  path and the type path; tested (cell-type.test.ts).
- `FactoryInput<T>` (alias-name detection) formats the inner type
  with `OpaqueCell` semantics, recursively opaque-unwrapping to find target
  wrappers, depth-capped at 10 (tested:
  factory-input-real-api).

### 6.4 `Reactive<T>` — no marker (settled)

`Reactive<T>` emits **no wrapper marker of any kind**. Evidence chain:

1. `Reactive<T> = T` is an identity alias (`packages/api/index.ts`) — no
   runtime wrapper, no structural brand, so structural detection cannot see it
   (explicit comment, `common-fabric-formatter.ts`).
2. Node-level detection deliberately excludes the spelling:
   `NODE_WRAPPER_SPELLINGS.Reactive = false`, comment: "wrapperKindForName has
   never treated it as a node wrapper" (`type-utils.ts`).
3. The one mapping that *would* emit a marker —
   `wrapperKindToBrand("Reactive") → "opaque"` (`cell-brand.ts`) — is
   unreachable: no detection path produces kind `"Reactive"`
   (`brandToWrapperKind`, `cell-brand.ts`, never returns it;
   `resolveWrapperNode` cannot).
4. Guard test: `capability-wrapper-types.test.ts` asserts
   `Reactive<{foo: string}>` yields the inner object schema with neither
   `asCell` nor `asOpaque`; fixture `reactive-stream` shows
   `Reactive<LLMState>` emitting a plain `$ref: "#/$defs/LLMState"`.

Hoisting nuance: `getNamedTypeKey` suppresses a key when the aliasSymbol
survives as `Reactive` (`type-utils.ts`); commonly the checker resolves
the identity alias to the inner type object itself (no aliasSymbol), so inner
named types still hoist, as the fixture shows. The ts-transformers behavior
spec §12 uses the same single-`asCell` vocabulary. Any doc claiming `Reactive`
emits `asCell: ["opaque"]` is wrong on this tree.

### 6.5 Stream event schemas — deliberately open (C5)

A stream property's schema object is the verb's **event** schema — what a
caller sends, which `cf piece verbs` publishes and `cf piece call` validates
payloads against. It carries no `additionalProperties` of its own — only
what the event type itself demands (an index signature, a `Record` value
type). The verb contract wants event schemas closed-world
(`additionalProperties: false` — an undeclared field is a rejection, never
ignored), but emitting that is blocked on a pattern-update-gate migration:
the argument-role compatibility rule refuses the open→closed direction for
verbs reachable through a piece's argument schema (plan
`docs/history/plans/pattern-verb-contract-implementation.md`, WS-C and Risks).
The
open event side is pinned as a decision in `test/stream-result.test.ts`; a
schema that declares the closure by hand is enforced at dispatch by the
runner (C5).

## 7. `Default<T,V>` And `DeepDefault<V>`

`Default` detection is two-axis: node references named `Default` (by
spelling, read through parentheses and alias chains — `resolveWrapperNode`,
`type-utils.ts`) and, when the checker erased the node, the type's
aliasSymbol — the latter **source-checked** to a `commonfabric` declaration
(`isDefaultAliasSymbol`, `property-optionality.ts`, through
`isCommonFabricSymbol`, `common-fabric-symbols.ts`), so a user type merely
*named* `Default` does not take the alias path. (Contrast §11: CFC detection
has no source check.)

**V extraction**, in priority order:

1. **Node-based** (`extractDefaultValueFromNode` + expression walk,
   `common-fabric-formatter.ts`; union-side twin
   `union-formatter.ts`): literal nodes, tuple nodes, object-literal
   type nodes, and `typeof CONST` queries resolved
   through import aliases to the variable initializer (unwrapping
   `as`/`satisfies`/parens/type assertions; shorthand properties via
   `getShorthandAssignmentValueSymbol`). Inline object and tuple types are
   extracted as a whole: an unresolved member at any depth makes the entire
   value unresolved. Non-property type members require the complete type to
   qualify as an empty record; they cannot be silently skipped. The applicable
   type/brand fallbacks still run before an unresolved-default warning is emitted.
2. **Type-based extraction** (both formatters): literal values, symbol value
   declarations, empty object-literal types, and empty records. An alias of `{}`
   yields `{}`, including through alias chains and imports, without requiring a
   symbol value declaration. Empty interfaces, classes, and the broad `object`
   type do not qualify as empty object-literal types. A record with no named
   properties or call or construct signatures, and at least one index signature,
   yields `{}` when
   every index value type is `never`. This includes `Record<string, never>`,
   `Record<PropertyKey, never>`, their intersections, and aliases of these types,
   in both `T | Default<V>` and `Default<T, V>`. The record check does not require
   a symbol value declaration. Every intersection constituent must be an object
   type; a primitive intersected with an empty record does not qualify. A
   propertyless record with `string` or `unknown` values does not qualify either.
   Nor does a type that merely carries a `never` type argument:
   `Record<"required", never>` and `Array<never>` both have named properties, so
   neither yields a default. An inline `Record<K, never>` in
   `Default<T, V>` reaches this rule through the node route's type fallback;
   there is no name-based shortcut.
3. **Brand-payload fallback**: `Default<T,V>` carries V in a
   `DEFAULT_MARKER`-branded payload; when the alias is resolved away
   (`T | (T & DefaultMarker<V>)`), the payload is read back type-structurally
   (`type-utils.ts`). Union-distributed brands must **agree**;
   disagreement bails to no-default with a warning. Only a member carrying an
   actual `DEFAULT_MARKER` property is a brand arm. An ordinary empty object or
   an unrelated symbol brand is a value member: it neither triggers this
   recovery nor prevents it, and is formatted with the rest of the union. The
   plain arm of `Default<{}>` or of `Default<Record<PropertyKey, never>>` is
   such a member, so those recover `default: {}`. Non-`never` index signatures
   cannot provide a literal default. Tested: brand-payload-defaults.test.ts and
   schema/default-diagnostics.test.ts.

After the applicable extraction routes for `Default<>` or `DeepDefault<>`
return no value, the generator reports
**Warning** `schema-default:unresolved` and attaches no default for that
annotation. `SchemaGenerationOptions.onDiagnostic` receives the message and the
authored node when available; without a callback the generator logs the warning.
The transformer forwards it to its diagnostic collector, deduplicated by source
location. An imported declaration is reported at the local schema use.
Successful fallback extraction and valid falsy defaults (`null`, `false`, `0`,
`""`) do not warn. Existing invalid-arity and `Default<undefined>` errors still
throw.

`default` may sit as a sibling of `$ref` (Draft 2020-12 rationale in comment,
`common-fabric-formatter.ts`); boolean schemas become `{ default }` /
`{ not: true, default }`.

**Union rules** (`union-formatter.ts`):

- At most one `Default<>` member per union — more **throws**.
- A default whose type is assignable to another member does not re-emit the
  `Default`'s T as a branch (`isDefaultCoveredByUnion`).
- An object default that would *widen* an existing object member **throws**,
  pointing at `DeepDefault`.
- `DeepDefault<V>` requires an object target and an object default type (else
  **throws**). An unrecoverable object value emits `schema-default:unresolved`
  with `DeepDefault<>` in the message and attaches no defaults. A recovered value
  applies nested per-property defaults, resolving
  through local `$refs` and single-object-candidate `anyOf`s; unknown keys
  **throw**.
- Expanded empty-array arms (`[]`/`never[]`) riding along expanded
  array-Defaults are pruned when a real array member exists, preserving element
  capabilities; an explicit comment notes this is safe only while arrays carry
  no length bounds (CT-1639).
- `Default<undefined>` (1-arg) **throws** at both sites
  (`common-fabric-formatter.ts`; `union-formatter.ts`); arity
  outside 1..2 throws (`common-fabric-formatter.ts`; `union-formatter.ts`).

**Optionality interplay:** `Default<T | undefined, V>` makes the property
non-required (`isDefaultNodeWithUndefined`, `property-optionality.ts`,
consulted at `object-formatter.ts`). Plain `T | undefined` does *not*
remove the property from `required`, but optional symbols (`?`) get
`| undefined` stripped from checker-resolved types (`safeGetPropertyType`,
`type-utils.ts`, union-order-insensitive comparison); a union-merged
result may still carry `type: ["number","undefined"]` (§8; fixture
`default-with-undefined-union`). Shared-definition safety: different defaults
on two uses of one named type do not mutate the shared `$defs` entry (tested:
defaults-no-def-mutation.test.ts).

## 8. Unions

`UnionFormatter` (`src/formatters/union-formatter.ts`), after the
Default paths of §7:

- **Nullable special case**: exactly one non-null alternative + `null` →
  `{ anyOf: [<member>, { type: "null" }] }` — `anyOf` over `oneOf`
  deliberately, "for better consumer compatibility" per the nullable-case
  comment in `union-formatter.ts`. Emission order is member-first; goldens
  may show null-first because the test normalizer canonicalizes nullable
  `anyOf` pairs (`test/utils.ts`).
- **All-literal unions** → `{ enum: [...] }` with **no `type` key**; `null`
  joins the enum when present; `undefined` never does (it forces the anyOf
  path). The pair `true | false` re-collapses to `{ type: "boolean" }`. When
  that pair is nullable, it emits
  `{ anyOf: [{ type: "boolean" }, { type: "null" }] }`. This is
  also what TS enums hit (§4).
- **`{ type: "undefined" }` preservation**: undefined members are kept, not
  stripped.
- **General case** → `anyOf` with **primitive merging**
  (`mergePrimitiveSchemaIntoAnyOf`): a `true` member
  short-circuits the union to `true`; `false` members drop; exact-JSON
  duplicates drop; same-`type` enum schemas merge enum sets (sorted); enum +
  bare same-`type` → bare type; bare primitive types merge into sorted
  **`type` arrays** — how `string | undefined` becomes
  `{ type: ["string","undefined"] }` (fixture `default-with-undefined-union`).
  Singletons unwrap.
- **`widenLiterals`** additionally merges member schemas that differ only in
  their literal values, an `enum` or a `const` whose values share one base
  type, widening those to that type, before the anyOf pass
  (`mergeIdenticalSchemas`). Every other keyword, at any depth, must match
  for members to merge, and the merged member keeps it: a cell and a plain
  value of one type, two cells under different labels, two named types (two
  `$ref`s), and literals of more than one type all stay separate members.
  It does **not** reach the all-literal path:
  `"a" | "b"` still emits `{ enum: ["a","b"] }` under `widenLiterals: true`
  (probe; the all-literal `enum` branch runs first and never consults the
  flag).
- Member nodes re-associate with semantic members order-insensitively
  (`orderMemberNodesBySemanticType`) — the checker canonicalizes
  union order. Union alias nodes resolve through non-generic alias
  declarations to recover member nodes (`getUnionTypeNode`).
  Empty unions **throw**.
- The checker folds a member that is itself a union into the union it is a
  member of, so one member node can stand for several members
  (`pairUnionMemberNodes`, which `#labelsOf` in `schema-generator.ts` reads
  members through as well):
  - A member node that writes a union, through parentheses and aliases
    without type parameters, pairs through the members it writes, each read
    at its own node. `Shape | null`, with `type Shape = A | B`, stays
    `{ anyOf: [{ type: "null" }, A, B] }`.
  - A member node whose type is a union it does not write, such as
    `Confidential<A | B, …>`, which the checker distributes into `A & …` and
    `B & …`, pairs with none of them. In the general case it is read once,
    as one alternative for all of them, where it is a CFC alias that
    `CommonFabricFormatter` reads: `Confidential<A | B, […]> | null` emits
    `{ anyOf: [{ type: "null" }, { anyOf: [A, B], ifc: … }] }`, with labels
    only the node can spell, as a `PolicyOf<typeof rules>` binding. Several
    such nodes can stand for the same members, as two whose policies differ
    only in a `typeof` binding do where the bindings have one type, and each
    is an alternative of its own, in the order written. Its members are
    otherwise read by their types: `boolean` stands for `true` and `false`,
    `Default<T, V>`'s place in a union is §7's, and a scope wrapper's is
    §10's, whichever way its node is read: beside only `null` or `undefined`
    the union is itself the wrapper, and beside any other value its scope
    lands in a branch and throws.
- The checker can also collapse several written CFC alternatives into a
  single semantic member. Each remains an alternative of its own, including
  `Confidential<A, [PolicyOf<typeof readers>]> |
  Confidential<A, [PolicyOf<typeof writers>]>` when `readers` and `writers`
  have the same declared type. This applies with or without `null`, and when
  the payload is itself a union. Where accepted CFC nodes share a semantic
  member, the written union is read before type-only CFC dispatch and before
  tracking that type as a cycle (`UnionFormatter.formatCollapsedUnion`).
  The alternatives sharing a member are themselves read inline, so an
  anonymous recursive definition cannot identify distinct policy bindings as
  one reading (`GenerationContext.inlineUnionMember`). Each alternative's
  payload still follows the usual definition and cycle rules. Tested:
  cfc-authoring.test.ts, narrowed-capture-labels.test.ts, and
  the runner's cfc-narrowed-capture-floor.test.ts.

## 9. Intersections

`IntersectionFormatter` (`src/formatters/intersection-formatter.ts`):

- Cell-branded intersections are declined; native resolution runs
  first; empty intersections throw.
- Brand-only (all `__@`-keyed) and empty-object constituents, and CFC
  metadata carriers, whose labels §11 reads, are filtered before validation;
  a single survivor delegates directly, and where none survives the full set
  is merged.
- An intersection of arrays is an array of the values every one of them
  holds: its `items` are the schema of the intersection's number index, the
  intersection of the element types, so `unknown[] & readonly string[]` is
  `string[]`'s schema. Tested: intersection-formatter.test.ts.
- Unsupported shapes — non-object constituent, constituent with an index
  signature, or a checker error — produce a **permissive fallback, not a
  throw**: `{ type: "object", additionalProperties: true, $comment:
  "Unsupported intersection pattern: <reason>" }`.
- A property several constituents declare takes the schema of its type in
  the intersection, which the checker gives as the intersection of the
  declared types: `{ a: unknown } & { a: string }` and
  `{ a: string | number } & { a: string }`, in either order, give `a` the
  schema of `string`, `{ a: string } & { a: number }` gives it `false`, and
  `{ a: unknown[] } & { a: string[] }` gives it `string[]`'s. Where one
  declaration's type is that very type, the property takes that
  declaration's schema, read through the node it is written with. Any other
  type is formatted as the property's, so what the checker keeps of every
  declaration is read from the type, whichever declaration wrote it: a scope
  wrapper's brand, as in `{ a: X } & { a: PerUser<X> }`, scoped to the user
  in either order (§10); a CFC carrier, whose labels go on the members of
  the payload it was written around (§11); and a `Default` brand.
  `{ a: { x: string } } & { a: { y: number } }` merges the two objects, and a
  callable keeps its wrapper marker.
- A property whose declarations are in different scopes, a cell's cap
  counting as its scope, is refused, as one value is stored in one scope:
  `{ a: PerUser<X> } & { a: PerSpace<X> }` throws "The property `a` is
  declared in scope `user` by one member of an intersection and in scope
  `space` by another. A value is stored in one scope, so declare `a` in the
  same scope wherever it is declared." Where the schema declares no scope, as
  an inferred lift result's does (§10), the declarations' scopes are not
  read, and a value two scope wrappers brand is read as its payload.
- The property's description, the tags drawn from it, and its deprecation
  mark are the first declaration's where it has them, and otherwise those of
  the schema it takes. A later declaration's differing description is noted
  in a `$comment` ("Conflicting docs across intersection constituents; using
  first") and a logger warning. `required` is unioned, as a property any
  constituent requires is required; `$ref` constituents resolve through
  `context.definitions`. Tested: intersection-formatter.test.ts,
  intersection-provenance.test.ts, the descriptions-intersection-conflict
  fixture.
- Constituent-level JSDoc joins with `\n\n` plus provenance `$comment`s ("Docs
  inherited from intersection constituents." / "Sources: …" / "Missing docs
  for: …") (descriptions-intersection-* fixtures ×7).

## 10. Scope Wrappers

`PerSpace` / `PerUser` / `PerSession` / `PerAny` (api: `Scoped<T, S>`, `T`
intersected with an optional `SCOPE_BRAND`-typed member for each of its members
other than `null` and `undefined`, which it holds as they are,
`packages/api/index.ts`) lower to a `scope` key with values
`"space" | "user" | "session" | "any"` (`SCOPE_WRAPPER_SCOPES`,
`common-fabric-formatter.ts`). The type keeps the alias it is reached by,
`PerUser<…>` or an author's own, as `Box<T>` in `type Box<T> = PerUser<…>`, so
`PerUser<T | null>` is read as any scope wrapper is, with `null` among its
payload's alternatives. Detection is by node name or aliasSymbol name, by
following the aliasSymbol's declaration down a chain of aliases, each the whole
body of the one before, to a scope wrapper (`scopeOfAliasChain`), and
otherwise by the brand the type carries (`getScopeBrand`,
`src/typescript/scope-brand.ts`): for a type the checker narrowed or built with
no alias, as assignment narrows `PerUser<boolean> | null` to the brand over
`false` and `true`, and for a union written beside a wrapper, as
`PerUser<A> | null`. A member of such a union that a scope wrapper's alias names
is read by that alias, its scope from the wrapper's name and its payload as the
argument written for it, so a generic `PerUser<T> | null`, whose brand is a
deferred type, is read as `PerUser<T | null>` is. That deferred brand is the
conditional `ScopeTag<T, S>`, named by its alias, so a generic wrapper no
alias names, as the intersection `PerUser<T> & PerUser<T>`, is read by it:
`<T extends string>` → `{ type: "string", scope: "user" }`. The brand with
nothing beside it (no other property, index signature or call signature, which
a mapped type over a wrapper, as `Readonly<PerSpace<Record<string, A>>>`, holds
beside the brand), as `PerUser<unknown>` resolves to once the checker drops
`unknown` from its intersection, is the wrapper around `unknown`:
`{ type: "unknown", scope: "user" }`, as a node naming the wrapper reads it.
`PerUser<{}>` resolves to the same type, as `PerUser<NonNullable<unknown>>`
does, so read by its type alone, as a record's values are, it is the wrapper
around `unknown` too, which a read takes for a reference
(`docs/specs/json_schema.md`, "Non-standard `type` values"); a node naming it,
written in place or as an alias's declaration, reads `{}` as any `{}` is read:
`{ type: "object", properties: {}, scope: "user" }`. The scope is the same
either way. The payload of a wrapper
read by its brand is its branded members with the brand taken off, each
alternative a member intersected with the brand read as that member
(`scopePayloadType`, `GenerationContext.scopeBrandRead`). A payload the
checker cannot intersect again without the brand, as `A & B` in
`PerUser<A & B>`, is the wrapper's own type, and is read in place rather than
as a type met again inside itself: by `CommonFabricFormatter` where it claims
the type for more than the brand, as for the labels of a policy in the payload,
`PerUser<Confidential<T, […]>>` or `PerUser<Confidential<A & B, […]>>`, whose
CFC parts pass over the brand (`cfcCarriedParts`), and otherwise by the
formatters after it (`formatStructure`). Such a payload that is a cell, as
`Cell<A> & Cell<B>`, is read as the cell. Where a union of one scope's
wrappers beside `null` or `undefined` is written as one, `PerUser<A> | null`,
at the position or as the body of the alias the type is reached by, followed
down a chain of aliases, each the whole body of the one before, under the
arguments each reference writes (`scopeOfWrittenScopedUnion`), the payload's
type is read at
the members written for it: the payload written in each wrapper, and each
`null` or `undefined` (`GenerationContext.scopePayloadNodes`), as the members
of `A | null` written in `PerUser<A | null>` are. So what only the syntax says,
the binding `PolicyOf<typeof rules>` names in
`type Box<T> = PerUser<Confidential<T, [PolicyOf<typeof rules>]>> | null`,
is kept, for a holder's values read by type too, and the two spellings read
alike. Each member is read through parentheses, aliases without type
parameters, and a union written in it, so `PerUser<A> | Nil` with
`type Nil = null`, and `(PerUser<A> | null) | undefined`, read as written out,
and a `never` member, which adds nothing to the union, is left out.
A union written for a scope wrapper whose members do not read so, as
`Maybe<PerUser<A>>` with `type Maybe<T> = T | null` writes one, where the member
is a parameter bound apart from the union, **throws** (``A scope wrapper
beside `null` or `undefined` is read from the union written around it``): its
type alone would lose what only the syntax names. A member's `?` takes the
`undefined` written beside a wrapper out of the type the member is read at, as
in `handle?: Box<A>` with `type Box<T> = PerUser<T> | undefined`; the wrapper
alone is then read at the member written for it, under the bindings it is
written with, and a cell there throws as a cell beside `undefined` does. The
node-based analyzer hands such a union to the same reading. The
payload of a wrapper found by name is
the wrapper's first argument as the last alias along the chain writes it, read
with each generic alias's parameters bound to the arguments written for them,
the same walk that lowers a CFC alias reached through aliases (§11):
`type Rec<T> = PerUser<{ value: T }>` read as `Rec<string>` →
`{ type: "object", properties: { value: { type: "string" } },
required: ["value"], scope: "user" }`, and a generic declaration the payload
names, as in `PerUser<Box<T>>`, reads with the argument too. Aliases are followed by declaration,
bare or namespace-qualified (`cf.PerUser<T>`), so two same-named aliases in
different modules do not stop the walk. Such a type is not hoisted (§5.1), and
is a scope wrapper for the union rule below. Tested: scope-wrappers.test.ts,
and end-to-end in ts-transformers `scope-wrapper-alias-schema.test.ts`
(pattern argument, handler state, and `computed()` capture, for local,
exported, and imported aliases). Placement
(`applyScopeWrapperSemantics`): if the inner schema has a
non-empty `asCell`, the scope merges into the **first** entry, turning a
string entry into the object form (`applyScopeToAsCellEntry`) —
`PerUser<Cell<string>>` → `{ asCell: [{ kind: "cell", scope: "user" }], type:
"string" }`; otherwise a bare sibling key — `PerUser<string>` →
`{ type: "string", scope: "user" }`. A payload that only references a cell's
definition, as a labelled cell's alias is hoisted, is the cell written in
place, with the cap on its first entry and the labels the references declare:
`PerUser<Handle>` with `type Handle = Confidential<Writable<T>, […]>` reads as
`PerUser<Confidential<Writable<T>, […]>>`, and the definition stays as it is
for the references that hold no scope. A wrapper around a cell **throws** beside
anything, `null` and `undefined` included, written outside it or inside, or in
an alias the payload names, whose union is hoisted into a definition the
payload references (`PerUser<Maybe>` with `type Maybe = Writable<T> | null`),
the cell in it hoisted too where its own alias is, as a labelled cell's is
(`A scope wrapper around a cell cannot hold anything beside the cell`). Beside
`null`, `undefined` or a value, the cell would be an `anyOf` branch, where the
cap on following its handle sits apart from the slot's scope, which the write
path reads; beside another cell, as in `PerSpace<Cell<T> | Cell<U>>`, a read's
value projection resolves no handle out of the union, so no read can show the
cap holding. A cell whose value may be `null` holds it inside
(`PerSpace<Cell<T | null>>` → `{ anyOf: [{ … }, { type: "null" }], asCell:
[{ kind: "cell", scope: "space" }] }`), and a handle that may be missing is an
optional property, which keeps the cell alone (`handle?: PerSpace<Cell<T>>` →
`{ …, asCell: [{ kind: "cell", scope: "space" }] }`). The union is read as
written, so `handle?: PerSpace<Cell<T>> | undefined` throws as well, including
where the type it is read at has lost that `undefined`, as `Required` takes it
out. Tested end to end in the runtime:
`packages/runner/test/ascell-scope-cap.test.ts`. A nested scope **without an intervening
cell boundary throws** (`Nested scope wrappers require a cell boundary between
scopes.`; tested, scope-wrappers.test.ts), and so does a type carrying two
scopes' brands on one value, as an inferred `PerUser<PerSession<T>>` resolves
to, except in a schema that declares no scope, which reads such a value as its
payload. Around a cell, the outer wrapper's scope would replace the cap the inner
one puts on the handle, so `PerSession<PerUser<Cell<T>>>` throws too, written
out or through an alias. Two brands of one scope fold into one, so a wrapper
nested in one of its own scope is that wrapper alone. With a cell boundary
both survive: `PerUser<Cell<PerSession<string>>>` → `{ asCell: [{ kind:
"cell", scope: "user" }], scope: "session", type: "string" }` (fixture
`scoped-wrappers`).

A payload whose schema is a boolean becomes an object for the scope to sit on:
`PerUser<any>` → `{ scope: "user" }`, and a payload that accepts nothing →
`{ not: true, scope }`. `never & brand` is `never`, so a wrapper around
`never`, or around a payload the checker reduces to it such as
`string & number`, has no type of its own, and a node naming the wrapper is
what keeps its scope: `PerUser<never>` → `{ not: true, scope: "user" }` at the
root and as a property, and `Cell<PerUser<never>>` →
`{ not: true, scope: "user", asCell: ["cell"] }` (tested,
scope-wrappers.test.ts, and end-to-end in ts-transformers
`never-payload-schema.test.ts`). Where no node names the wrapper, `never`
carries no alias or brand to find it by, so an alias of one
(`type Rec = PerUser<never>`), a record's values, and a tuple's elements lower
as `never` does, to `false`. A wrapper around `null` or `undefined` alone is
that type, which `Scoped` keeps outside the brand, and likewise keeps its scope
only where a node names the wrapper: `PerUser<null>` → `{ type: "null",
scope: "user" }`, and an inferred one lowers as `null` does.

The payload is read from the node when a node names the wrapper, so that
structure only the node carries reaches the schema. The wrapper type's own
first type argument supplies the payload instead in two cases, and only where
the type is itself a scope wrapper. One is a payload whose node degrades to
`any`, as every node the printer wrote from a type does: its names resolve to
nothing at the position it is emitted into, and a node-driven schema would
accept anything there. The other is a payload read only in part, of which the
printer produces three members: the two §6 names — `import("./mod.ts").T` for
a name the emitting module does not import, and the
`T & { readonly [DEFAULT_MARKER]: V }` arm of an expanded `Default`, which
carries the default — and a wrapper whose argument the printer left out
because it equals the parameter's default (`SqliteDb` for
`SqliteDb<SqliteDatabase>`), which names no payload. A printed wrapper with no
argument takes it from the resolved wrapper type where the caller has one, and
is otherwise left unread; an authored one still throws. Both cases cost
whatever narrowing the node carried: the schema is then that of the whole
declared value. Tested: scope-wrappers.test.ts, and
end-to-end in ts-transformers `aliased-binding-declared-type.test.ts` and
`scoped-interface-schema.test.ts` (local, exported, and imported interfaces).

A scope wrapper **as a union member beside another value throws** (`A scope
wrapper cannot be a member of a union.`; tested, scope-wrappers.test.ts), as
in `PerUser<string> | number`. The runtime reads a
slot's scope from that slot's own schema — its top level, or the definition a
`$ref` there names (`ContextualFlowControl.getSchemaScopeCap`) — and from no
compound branch, so a declaration that lands in an
`anyOf` branch is invisible to the write path: no narrowing redirect is
written, the value lands on the shared space row, and every principal reads
the same instance. Write the union inside the wrapper
(`PerUser<string | number>`) to keep the scope at the top level. Beside
`null` or `undefined` alone, a wrapper is read as the wrapper around them, as
`Scoped` holds them, and scopes the whole slot as that does: `PerUser<string> | undefined` and `PerUser<string | undefined>` →
`{ type: ["string", "undefined"], scope: "user" }`, and `PerUser<boolean> |
null` → `{ anyOf: [{ type: "boolean" }, { type: "null" }], scope: "user" }`.
An optional property keeps the scope at the top level too
(`draft?: PerUser<string>` → `{ type: "string", scope: "user" }`).

Two detection points enforce this, because a wrapper around a cell loses its
scope before the schema is built. `formatWrapperUnion`
(`common-fabric-formatter.ts`) catches a scope-wrapped union member while the
wrapper is still visible; `assertScopeDeclarationsAreReachable`
(`scope-placement.ts`), run on every finished schema, catches a scope that
reached an `anyOf`/`oneOf`/`allOf` branch by any route. A scope nested deeper
— on a property of an object that is itself a union member — is that
property's own top-level declaration and is accepted.

Generated with `declaresNoScope` (`SchemaGenerationOptions`), a schema
declares no scope at all: each scope wrapper is read as its payload, with no
`scope` and no cap on a cell's `asCell` entry, a recursive one's references
included, and neither detection point above has a scope to refuse. The
transformer generates a lift's result this way where its type is one no
author wrote (ts-transformers behavior spec §10.4), since the runtime stores a
lift's result at the narrowest scope its callback reads.

## 11. CFC Alias Lowering (`ifc` Metadata)

The canonical authoring surface contains 18 names. The inventory is
`CFC_CANONICAL_ALIAS_NAMES` (`packages/api/cfc.ts`), consumed by
`CommonFabricFormatter`. Sixteen aliases lower the wrapped value and attach an
`ifc` payload; `AnyOf` and `PolicyOf` are label-expression markers interpreted
inside those payloads.

| Alias | `ifc` payload |
| --- | --- |
| `Cfc<T, M>` | spread of the record literal `M` (non-record → no metadata) |
| `Confidential<T, C>` | `{ confidentiality: C }` |
| `Integrity<T, I>` | `{ integrity: I }` |
| `AddIntegrity<T, I>` | `{ addIntegrity: I }` |
| `RepresentsCurrentUser<T>` | `{ addIntegrity: [{ kind: "represents-principal", subject: { __ctCurrentPrincipal: true } }] }` |
| `AuthoredByCurrentUser<T>` | `{ addIntegrity: [{ kind: "authored-by", subject: { __ctCurrentPrincipal: true } }] }` |
| `RequiresIntegrity<T, I>` | `{ requiredIntegrity: I }` |
| `MaxConfidentiality<T, C>` | `{ maxConfidentiality: C }` |
| `AnyOf<X>` | when nested in an IFC label tuple, one atom `{ anyOf: X }` |
| `PolicyOf<typeof rules>` | when nested in an IFC label tuple, a policy atom carrying a compile-time module-binding marker; the ts-transformer resolves it to `{ type, policyRefKind: "module", subject, moduleIdentity, symbol, policyDigest }` |
| `WriteAuthorizedBy<T, typeof b>` | `{ writeAuthorizedBy: { __ctWriterIdentityOf: { file, path: [binding], moduleIdentity? } } }` |
| `TrustedActionWriteWithIntegrity<…>` | writeAuthorizedBy metadata + `uiContract { helper: "UiAction", action, trustedPattern, requiredEventIntegrity }` |
| `TrustedActionWrite<…>` | same, with `requiredEventIntegrity` defaulting to `[trustedPattern]` |
| `WritePolicyAnyOf<T, [P, …]>` | `{ writePolicyAnyOf: [p, …] }`, each `p` the lowering of one member `P` — a `WriteAuthorizedBy`, `TrustedActionWrite`, or `TrustedActionWriteWithIntegrity` over `unknown`, directly or through a user alias. The tuple must be written in place and nonempty, with no optional or rest member, and each member must lower to a writer; otherwise generation throws |
| `TrustedActionUiContract<…>` | `{ uiContract: { helper: "UiAction", action, trustedPattern, requiredEventIntegrity? } }` |
| `ExactCopy<T, S>` | `{ exactCopyOf: S }` |
| `ProjectionPath<T, F, P>` | `{ projection: { from: F, path: P } }` |
| `ProjectionOf<T, P>` | `{ projection: { from: "/", path: P } }` |
| `Projection<SourceRef>` | what the checker resolves it to: `ProjectionOf<Root, Path>` for a `Ref<Root, Path>`, `never` for anything else, member by member for a union |

Mechanics:

- Detection is **canonical-name keyed** — `CFC_ALIAS_NAMES.has(aliasName)`.
  Imported aliases are resolved back to their exported name, so renamed
  imports of `AnyOf` / `PolicyOf` work. A local declaration using a canonical
  name also lowers; unlike `Default`, there is no declaring-package guard
  (§7), so name collisions remain an untested foot-gun.
- Qualified metadata references to `AnyOf` and `PolicyOf` receive their special
  lowering only when the resolved symbol comes from Common Fabric. Provenance
  follows import and re-export hops, including `commonfabric/cfc`, renamed
  exports, and namespace re-exports, so companion declarations need no special
  file path. An unrelated namespace member with the same name is read from its
  own declaration as ordinary metadata.
  An authored wrapper around a library alias is also read from its declaration,
  preserving any binding fixed inside the wrapper.
- `Projection` is a conditional type, so the lowering never follows it by
  syntax: a user alias chain that reaches it stops there, and the type written
  with it is read as the checker resolved it, as the direct spelling is.
- A canonical alias reached by its own name reads its payload, like its
  labels, from the reference's own argument nodes when that reference names
  the same alias. A reference to a conditional alias whose one branch other
  than `never` names the canonical alias holds its arguments as that branch
  writes them: an argument that is one of the conditional alias's parameters
  is the reference's argument for it, and one holding no parameter is itself.
  An argument holding a parameter the conditional checks or infers is read
  from its type, since the checker binds such a parameter member by member,
  and so is any other argument that holds a parameter without being one
  (`T[]`, `keyof T`).
  Any other reference to an alias the checker resolved to it (`MyProjection<R>`
  to `ProjectionOf<Root, Path>`) holds that alias's arguments, so the canonical
  alias is read from its type alone. A `WriteAuthorizedBy` written through
  another alias, whose binding neither way reads, is the
  `cfc-write-authorized-by:unread` error (`writer-binding-diagnostics.ts`),
  since its schema would carry no write restriction. A binding node that is
  not a direct `typeof` of an identifier reports the same error, including an
  alias for `typeof writer` passed through another alias's parameter: its type
  does not stand in for the written binding. A parameter bound only to a type,
  with no argument node, remains a type-only read rather than an authored
  indirect binding and is not reported by this check. A payload that is itself a
  CFC alias therefore lowers as it would if written on its own: a generic alias
  keeps its argument (`Integrity<Sec<string>, I>` is a string), a nested
  `WriteAuthorizedBy` keeps its `typeof` binding, and a nested label keeps its
  `AnyOf` clauses. A named type in the payload stays a `$ref` to its
  definition.
- A label lands on the part of a value its policy was written around. Each
  carrier records that payload beside its metadata (`CfcStamp<T, M>`,
  `packages/api/cfc.ts`), because TypeScript merges a carrier into whatever
  its value is merged into: an intersection, a spread, a mapped type. So a
  label is placed by the payload it records, never by where the carrier sits
  (`placeCarriedLabels`, `payloadReach`):
  - A restriction lands wherever the payload's data may be: on each member of
    the value the payload names, and on each member with no declaration. A
    mapped type that renames its keys keeps no member's declaration, nor does
    a spread of its result, so a renamed member, which holds the payload's
    data under a name the payload does not have, is reached too. It lands on
    the whole value where the payload has an index signature, whose keys are
    open. Restrictions are
    `confidentiality`, `requiredIntegrity`, `maxConfidentiality` and the
    writer policies, and `exactCopyOf` and `projection`, which the runtime
    verifies at the write.
  - Evidence (`integrity`, `addIntegrity`) lands only where the payload's data
    must be: on members whose declarations are the payload's own, a member
    `Record` synthesizes counting where the payload's has no declaration
    either. It does so only where nothing between the value and its carriers
    writes over members (`holdsCarriersUnwritten`): an intersection, or a
    mapped type over one. A spread's result never qualifies, since a later
    spread of the payload's own type keeps the payload's declarations. Nor
    does an object type holding a carrier beside members or an index signature
    of its own, as an interface extending a CFC alias does, or a mapped type
    whose carrier did not come from the type it maps over.
  - A label reaching every member lands on the whole value, and one reaching
    none lands nowhere. A union payload's members are those of each
    alternative.
  - A payload whose type lists no members, such as `{}` or `unknown`, may
    hold data under any key, so a restriction labels the whole value. Its
    evidence labels the whole value only where nothing writes over members
    and the value holds nothing besides: `Integrity<{}, L>` carries `L`, but
    `{ ...tagged, name }` and `{ name } & Integrity<{}, L>` do not.
  - A primitive, alone or beside carriers and brands, is all the data its
    value holds, so a payload that is or includes a primitive labels such a
    value whole: `Integrity<string, L>`, and the `string` alternative of
    `Confidential<string | { a: number }, L>`. A primitive intersected with
    an object that holds data of its own, under a name or an index
    signature, as in `Integrity<string, L> & { name: string }` or
    `Integrity<string, L> & Record<string, number>`, is placed as an object.
  - A carrier that records no payload, its metadata alone, is taken to have
    been written around the one member it is intersected with, where there is
    one. Beside more, a restriction labels the whole value and evidence lands
    nowhere (`payloadOfStamp`).

  So `A & Integrity<B, L>` labels `B`'s members alone, and
  `Omit<A & Integrity<B, L>, keyof B>` carries no label. `{ ...b, name }`
  carries `B`'s restrictions on `B`'s members and none of its evidence.
  `Integrity<A & B, L>` with its name dropped labels the whole value. A type
  can state evidence its value does not carry, as a generic spread
  `{ ...a, ...b }` typed `A & B` does, or `Object.assign`. Such a type reads
  as it states. Tested: cfc-authoring.test.ts ("a carrier that records the
  payload its policy was written around", "a carrier that records no
  payload"), and end-to-end in ts-transformers
  `printed-type-node-schema.test.ts` ("a labeled payload merged into a larger
  value").
- A policy's type can lose its alias name. A payload member its metadata
  carrier cannot intersect is reduced away: `Confidential<string | null, L>` is
  `string & carrier`, and `Confidential<null, L>` is `never`. A rewrite such as
  `NonNullable<…>`, which intersects with `{}`, drops the name too. A written
  reference that names the policy still lowers it from its own arguments,
  `null` and a `typeof` writer binding included. A payload that is itself
  `never`, as in `Confidential<never, L>` or `Confidential<string & number, L>`,
  accepts nothing, and lowers to `{ not: true, ifc }` like any payload whose
  schema is `false`, whether written directly or through an alias (`type Sec<T>
  = Confidential<T, L>`, `Sec<never>`). Read from a type alone, the
  value is the intersection of its members besides the carriers
  (`cfcCarriedParts`), labeled with each carrier's metadata as its types
  spell it, provided every value in it reads. A writer binding, which only a
  `typeof` node names, does not, and a policy read in part could claim what
  its author never wrote together, such as an `ownerPrincipal` without its
  `writeAuthorizedBy`. Then the value is its payload alone. The `null` the
  checker dropped is in the schema neither way. One member is read as itself.
  A payload that is itself an intersection leaves several, and only the
  payload each carrier records says which of them its policy was written
  around: `A & Confidential<B, L>` is the type `Confidential<A & B, L>` is,
  yet labels `B`'s members alone, while `Confidential<A & B, L>` labels the
  whole value (above). A payload the checker drops from an intersection, as it
  drops `unknown` and `{}`, leaves none, only the carriers of nested
  policies. The checker's public API builds no intersection apart from the
  carriers, so several members, or none, are read in place, as their
  intersection reads: by the CFC formatter where it claims the type for
  anything besides its carriers, as it claims a cell, and otherwise as §9
  reads an intersection, a carrier no constituent of it. So
  `NonNullable<Confidential<A & B, L>>` reads as `Confidential<A & B, L>`
  does, `string & Brand` as a labeled string, and none as a labeled object
  with no properties, as a lone carrier reads (below). A payload holding a
  union distributes, `(A | C) & B` being `(A & B) | (C & B)`, and each
  member of the union is labeled.
- A default-library alias that maps an object's members (`Readonly`,
  `Partial`, `Required`, `Pick`, `Omit`) does not keep a labelled operand's
  carrier as a member of its own: over an object it folds the carrier into
  the object it builds, as one more property, which `Pick` may leave out,
  and over a primitive it builds an object of the primitive's methods. Read
  by type, such an alias over a labelled operand (an intersection holding
  carriers, or such an alias in turn) is the type the checker builds, read
  as any other type is and never holding the carrier, labelled with the
  operand's labels, read from its carriers in full or not at all and placed
  by the payloads they record (above). Only
  where `Readonly`, `Partial` or `Required` stands over a primitive, which
  such an alias leaves as it is, is the value the primitive; a payload of
  several members, or none, is an intersection, which they map as they map
  an object. So
  `Readonly<Sec<string>>` is a labelled string, `Pick<Sec<string>,
  "length">` a labelled `{ length: number }`, a recursion through
  `Partial<Node>` a definition of its own, and `Pick<Sec<X>, "a">` keeps the
  label though `Pick` drops the carrier. The checker names a `Pick` or an
  `Omit` over literal keys by a user's alias of it, and holds that alias's
  arguments, so an alias whose whole body references another alias is
  followed to it, down a chain of such aliases, until it reaches one of
  these; a chain that reaches anything else, or comes back to an alias on
  it, is not followed. Each alias along the chain binds its parameters to the
  arguments the one before writes for them, one left out to its parameter's
  default, and the first alias to the checker's arguments. The operand is the
  type the last alias's reference writes, read under that alias's bindings,
  so the alias reads as the one it names written out with its arguments in
  place: `Select<Sec<X>>`, where `type Select<T> = Pick<T, "a">`, as
  `Pick<Sec<X>, "a">`, and `Select<["b"]>`, where `type Select<L> =
  Pick<Confidential<X, L>, "a">`, as `Pick<Confidential<X, ["b"]>, "a">`. A
  bound parameter is its argument, and a carrier's metadata is read with the
  parameters it holds bound. Where a member of the operand's payload is a
  bound parameter, the checker folds the argument into the operand's
  intersection:
  the carriers of an argument that is itself labeled join the operand's, and
  an argument that leaves the intersection no carrier (`never`, `null`,
  `undefined`, a union of the last two, or `any`) leaves the operand
  unlabeled. Any other argument keeps the operand's carriers as they are, a
  union among them, whose every member carries them, though the alias
  written out distributes its intersection over the union and reads
  unlabeled. Both sides bind the first alias's parameters to the checker's
  arguments, never to the ones a reference writes, so they agree. Written
  under bindings, a `Pick` or an `Omit` of a labeled operand keeps the label
  too, while a user's alias of one there is a mapped type over a bound
  parameter, which is not fully read (below). Any other object that holds a
  carrier as a property, as a mapped type its author wrote does
  (`{ readonly [K in keyof Sec<X>]: Sec<X>[K] }`), is labeled by it, each
  metadata the carrier's type holds read in full or none and placed by the
  payload it records (above), and never holds the carrier as a member: no
  value does.
- User alias chains are followed with type-parameter node substitution until a
  canonical name is reached (`#resolveAliasChainFromDeclaration` /
  `substituteTypeNode`), and the labels read the substituted argument nodes.
  Substitution starts at the authored reference's declaration, including a
  function-local generic alias whose resolved type reports an inner alias:
  the outer reference's arguments belong to the outer declaration's
  parameters. Fixed writer bindings and default value arguments are read from
  that declaration. References qualified through a namespace import are
  followed by resolving their full type name, including within a nested
  policy payload. Cycle detection tracks resolved declarations, so aliases
  with the same name in different modules remain distinct. Qualified metadata
  aliases such as `cf.CurrentPrincipal` resolve through the same import. Type
  arguments are converted to checker types only when the chain reaches a
  canonical policy alias. Unresolvable expansions fall back to ordinary
  generation (tested). An argument a reference leaves out is its parameter's
  default, read with the arguments before it, as the checker instantiates one.
  A reference to an alias whose whole body is one of its own parameters
  (`type Id<X> = X`) denotes the argument it writes for that parameter, so the
  chain, and the labels and defaults read from its syntax, start at that
  argument (`readThroughIdentityAliases`, `src/typescript/type-node.ts`).
- Plain generic declarations use the bindings of §4.1 whether their arguments
  carry writer queries or ordinary values. Readable properties and index values
  retain their declaration syntax alongside their instantiated types. This
  preserves both a whole policy argument (`Box<WriteAuthorizedBy<string,
  typeof save>>`) and a writer parameter used by a member's policy
  (`Pair<typeof save, typeof other>`). The library-alias syntax branch follows
  declarations and fires when a writer query is reachable, including through
  a named policy alias such as `Readonly<Protected>`. An ordinary value query
  such as `Partial<typeof value>` retains the checker's utility-type semantics.
  Non-generic tuples and literal index signatures also retain authored writer
  queries. Recursive definitions keep each writer's query origin even when
  handlers have identical types. An indexed access or conditional member that
  leaves a writer carrier without binding syntax reports
  `cfc-write-authorized-by:unread`; compilation cannot silently discard the
  restriction. Pattern input and explicit output schemas are pinned by
  ts-transformers `test/generic-writer-policy.test.ts`; runner
  `test/generic-writer-policy.test.ts` pins authorized and refused writes,
  including stored reloads.
- The payload is read from the declaration of the last alias along the chain,
  as written, with each parameter bound to its argument
  (`GenerationContext.boundTypeParameters`), never from a substituted node,
  whose rebuilt references the checker cannot resolve. A parameter's argument
  is the node written for it, read under the bindings of the place it is
  written: the reference itself, or the declaration before it along the
  chain, so `type Outer<X> = Sec<X[]>` reads `Sec`'s parameter as `X[]` with
  `X` bound to `Outer`'s argument. A default is read under the bindings of the
  parameters before it, and a bare reference to a bound parameter is that
  parameter's argument. Wherever the walk reaches a bound parameter, in a
  union's member, an intersection's part, an array's element, an object's
  property, or a member of a generic declaration the checker instantiates with
  it, its argument is read, from its node where it has one, so what only
  syntax says survives: a `Default`, a `PolicyOf<typeof rules>`, the binding
  of a nested `WriteAuthorizedBy`. A node holding a bound parameter is read by
  its syntax where its type is built from the checker's unbound parameter: an
  object, an array, a tuple, a union, an intersection, `readonly`, a
  default-library alias the node-based analyzer applies (`Partial`, `Pick`,
  …; a module's own alias of that name is its own), and a `Default`; any
  other node is read by its type. A union or an
  intersection is thereby read by its written members, since the checker
  folds a member that is itself a union, a CFC alias over one among them,
  into the whole and loses its boundary and labels. A label written as a
  bound parameter reads its argument, from its node where that names no
  parameter of its own.
- A chain entered with no argument nodes, as from a type whose print expands
  the alias, binds each parameter of its first alias to its argument's type.
  So does a chain whose written arguments name a type parameter the reading
  does not bind, as a member of a generic declaration the checker has
  instantiated does: its argument is in the instantiated type, not in the
  member's syntax, and the parameter is left unbound. Every CFC alias adds its
  metadata to its payload as one more member of an intersection, a carrier
  holding only `__ct_cfc__`, so the intersection's other member is the
  innermost payload, the argument in wherever the declaration wrote the
  parameter (`cfcPayloadOf`). For such a chain, and for a written payload
  using a parameter where no reading under bindings reaches (an indexed
  access, a conditional type, `keyof`, a mapped type, a template literal
  type), the payload is read from the type the chain instantiates, less the
  `undefined` an optional member's `?` adds, where that has one other member
  and the payload is no CFC alias of its own, whose labels the carriers merge
  with the chain's. A payload that is itself an intersection or a union has
  no one other member, and is read from its declaration under the bindings.
  A payload that is a CFC alias is read as its own chain, at the type the
  outer chain instantiates: that type's payload, every carrier taken off, is
  the inner alias's, while the inner chain's labels are read from its own
  arguments.
  Such a member's payload is therefore read as the checker instantiates it,
  so a `null` its declaration writes beside an object-shaped payload
  (`Confidential<{ v: T } | null, L>` as `Holder<string>`'s member) is not in
  the schema on either side, the carrier having left nothing of it.
- A use no binding reaches, such as a type the checker defers over a bound
  parameter (`T["name"]`, a conditional type), a mapped type over one, or a
  parameter left unbound, accepts any value there, and the payload is reported
  as not fully read. A mapped type reached by its type, with no written node,
  counts as one over a bound parameter when it has no member or index
  signature and a string is not assignable to it: over an unbound parameter
  the checker lists none, while a concrete empty one is the empty object
  type, to which a string is. A reading under bindings carries the type the
  checker instantiates at the position it reads, where it has one
  (`GenerationContext.instantiatedAs`): the payload of the type the chain
  instantiates, and in turn, wherever the reading goes within it, the part of
  that type in the same place: a property, the element of an array or a
  tuple, the value of a record or an index signature, the value a cell or a
  `Default` holds, the one member of a value that is also `undefined` or
  `null`, the argument of an identity alias, and, for the operand of a
  default-library alias read member by member (`Readonly`, `Partial`, `Pick`,
  …), the alias's own instantiation. A chain entered there takes it as its
  instantiation. A type read under bindings is
  identified, as a recursive definition's name and in cycle detection, by its
  type together with that instantiation and the arguments as written, or with
  its bindings where no instantiation is carried. Each argument also retains
  the ordered `typeof` bindings reached through its outer bindings and
  alias bodies, identified by the writer declaration they resolve to (or by
  the query node where no writer resolves): two writers with the same function
  type still name distinct write policies in recursive definitions. Repeated
  union and intersection members contribute their query origins once, so adding
  the same policy again does not change the recursion key. An alias's arguments,
  including defaults read under earlier arguments, contribute at their uses in
  its body, under that position's union or intersection operator. Two
  instantiations of one declaration keep apart. A recursion whose instantiation
  the checker settles to the same type (`Sec<T | undefined>` inside `Sec<T>`)
  refers to its definition when its query origins also settle. Conditional and
  indexed aliases can retain query syntax the checker drops, or repeat a
  parameter under an operator other than union or intersection, so their keys
  may keep growing even when their types settle. Such chains reach the nesting
  limit and report an error.
- A chain is also tracked from the written reference it is entered from
  (`SchemaGenerator.readAliasChain`), so a chain entered again from that
  reference inside itself is found as a recursion through it. One whose
  instantiation is only assignable both ways with the enclosing reading's, a
  different type with the same members (`Sec<Readonly<Readonly<X>>>` inside
  `Sec<Readonly<X>>`), refers to that reading's definition. So does one whose
  type arguments denote the same types as that reading's, compared in their
  written form under the bindings of the place each is written: a bound
  parameter as its argument's form, a node holding no type parameter as the
  type the checker gives it, by identity, a union or an intersection as its
  members flattened, a reference as the declaration it names and its
  arguments' forms, and an array, a tuple, `keyof`, `readonly` or a type
  literal as that construct and its parts' forms, each member's name kept
  apart from its optional and readonly modifiers, so `{ v?: U }` and
  `{ "v?": U }` differ, and a numeric name apart from a string one. Any other
  node holding a type parameter has
  no form and settles nothing. The same reference over the same types is the
  same reading. That
  settles a recursion wherever the reading has lost the instantiation at its
  position, as through a tuple's rest, `Readonly` or `Required` around the
  alias, or a union with another value; `Nest<T[]>` denotes a deeper array at
  each step and settles to none. The comparison is of types, never of the
  schemas they read as: `[string, number]` and `[number, string]` read as one
  array schema, but an alias indexing its argument (`X[0]`) tells them apart.
  An argument holding a type parameter the reading does not bind, as a
  payload read from its instantiation leaves its own, has no form, and
  settles nothing. Where the arguments of either reading hold a `typeof`
  query, neither settle applies: a writer binding is an identity that no type
  shows, so such a recursion ends where it meets the same reading again. A
  reading settles only to one that stores a definition, never to a wrapper's
  or a scope's around a cell. A scope wrapper's
  chain is read the same way, its payload being the one member its
  instantiation intersects with the scope brand, except a scope around a
  cell (`scopesCellHandle`): its cycle is found at the cell's value, which
  keeps the handle the scope caps at each reference, so it settles none, and
  under bindings, where that value is read from its syntax, a recursion
  through one is found only at the nesting bound. A chain reached with no
  written reference, as through a generic declaration's index signature or
  a tuple element read by type, is tracked by the alias it is reached by,
  and settles none: two readings of one alias through no written reference
  may be a nesting its author wrote out, whose instantiations the checker
  finds assignable both ways though they read differently. A reference, or
  such an alias, entered `MAX_BOUND_NESTING` deep without settling, like the
  same type read inside itself with the same arguments written for it, each
  under deeper bindings, is taken for a recursion that instantiates the chain
  without end (`Nest<T[]>` inside `Nest<T>`) rather than a nesting its author
  wrote out (`Pair<Pair<string>>`). The bound is three nested readings. A CFC
  alias chain reaching it reports a `cfc-schema:recursion-limit` error, including
  one whose writer-query key cannot settle. Its unread remainder would discard
  confidentiality or write policies, so the schema must not be used. A chain
  reached by its alias is located at the type node its context reads where
  there is one, and is otherwise reported without a location. The separate
  bound on a type read under bindings and a scope-wrapper chain reaching its
  nesting bound continue to report an unread-type warning. A scope-wrapper
  chain reached by its alias, with no type node to name, is named in that
  warning by a print of the type it stops at, made with `IgnoreErrors` so that
  every type has one, a type holding `[]` among them.
  A label reads a parameter it holds as its type wherever the label reader
  pairs that position. A `typeof` binding that a chain entered from a type
  receives only as a type argument cannot be read from a type, so a
  `writeAuthorizedBy` claim whose binding arrives that way is not emitted; one
  written in the alias declaration itself is read from the declaration.
- Metadata values come from type-level literals (`extractLiteralLikeValue`).
  Syntax says what a type cannot, such as which binding a `typeof` names, so
  a label's syntax is read first, each node paired with the part of the type
  it denotes: literal nodes, tuples, type literals, `readonly`, `typeof` value
  reads, and alias references, with the alias's arguments substituted into its
  body. A spread tuple element (`...X`, named or not) stands for the
  elements of the list its operand reads as, so `readonly [...L, "b"]` with
  `L` bound to `readonly ["c", "d"]` reads as `["c", "d", "b"]`; the tuple's
  type holds those elements spread already, so no element node pairs with a
  part of it, and each is read alone. Syntax the reader does not evaluate,
  such as a conditional or mapped alias, an optional tuple element, a spread
  whose operand reads as no list (a rest element over an array type), a tuple
  any of whose elements a spread leaves unread, or a parameter an alias leaves
  to its default, is read from the paired type instead, and so is a label
  with no syntax at all. Read from nodes, the extraction recognizes
  `AnyOf<X>` as `{ anyOf: X }` and `PolicyOf<typeof rules>` as a policy atom
  containing `__ctPolicyIdentityOf: { file, path }`, each where the alias the
  reference names is that operator's brand:
  `{ readonly __ct_cfc_any_of__?: X }` or
  `{ readonly __ct_cfc_policy_of__?: Rules }`. An alias an author declares
  under either name, and not as its brand, is read as the type it is, from
  its syntax as from its type. Read from a type, an object type's
  member is read at its declared annotation, paired with its type, wherever
  that annotation denotes the member's type apart from the `undefined` an
  optional member's `?` adds (`readMemberAnnotation`,
  `src/typescript/type-node.ts`). That is how a label written in a type
  literal or an interface keeps a binding that only its syntax names. The same
  member of a generic declaration, instantiated, is read from its type, as is
  the value of an optional member with no such annotation. Read from a type,
  a type parameter the reading binds is its argument, as a bare reference to
  it is, and a spread element of a tuple (`[...L, "b"]`) is the elements of
  the list it reads as, or one unread element where it reads as none.
  `AnyOf<X>` is recognized by its brand, `{ readonly __ct_cfc_any_of__?: X }`,
  never by an alias name, so an authored type named `AnyOf` is read as
  itself. A `PolicyOf` reached from a type alone, with no annotation that
  denotes it, has no binding to read: its brand is read as an ordinary object,
  `{ __ct_cfc_policy_of__: undefined }`, not as a policy atom. A label list the
  extraction cannot read in full is reported as the `cfc-label:unread` warning
  (`unread-label-diagnostics.ts`), naming the label: an argument that is not a
  tuple, or an atom with anything unread in it, whether the atom itself, a
  field of an object atom, or an alternative of an `AnyOf` clause. A union of
  literals is one such thing, and that `PolicyOf` brand another. A UI
  contract that writes no `requiredEventIntegrity` requires its trusted
  pattern, and that list is checked too. The schema carries what it could not
  read as no label, as an atom that serializes as `null` (an unread value, not
  an authored `null`, which is a literal read like any other), or as a field
  left out.
  Projection paths encode as JSON Pointers with `~0`/`~1` escaping
  (`encodeJsonPointerPath`).
- `ifc` combines with the base schema's existing `ifc` one key at a time
  (`combineIfcLabels`, `src/ifc-labels.ts`); boolean schemas become
  `{ ifc }` / `{ not: true, ifc }`. Nested wrappers
  (`Confidential<Confidential<T, A>, B>`) label one value twice.
  `confidentiality` lists join, inner first, each atom kept once by value
  equality. Every other key is kept from whichever wrapper declares it, and two
  wrappers declaring it differently is a generation error: those keys have no
  agreed combination, and keeping either one would drop the other silently.
- A wrapper around a named type whose definition carries `ifc` writes its label
  beside the `$ref`, and the runtime's resolver lets a keyword beside a `$ref`
  replace the definition's, `ifc` as a whole. So after formatting,
  `stateReferencedIfcLabels` rewrites the `ifc` beside each local `$ref` as
  the labels of every definition along its root-reference chain, farthest
  first, combined with its own by the same rule. A definition keeps its own
  `ifc`, which is all a reference without one resolves to.
- `WriteAuthorizedBy` writer identity resolves through import aliases to the
  declaring file. A transformer caller supplies
  `writerIdentityForSourceFile`, which maps that compile name to its authored
  spelling and can attach the defining source's content-addressed
  `moduleIdentity`; the runner supplies both, so engine-minted claims are born
  stamped. A transformer identity map that omits the defining source is a
  compile error, rather than a silent downgrade to an unstamped claim.
  Standalone schema-generator callers that omit the callback retain
  the legacy fallback (backslashes → `/`, first path segment stripped by
  `normalizeWriterIdentityFile`). The transformer also handles the direct-root
  `toSchema<WriteAuthorizedBy<T, typeof b>>` form specially so the wrapper's
  value schema remains the root while the same identity marker is attached.
  The writer identity is update-volatile in the piece compat checker in two
  ways, and `assertPatternSchemasBackwardCompatible` normalizes both out of the
  `ifc` comparison. The content-addressed hash (`moduleIdentity`, and the
  legacy `bundleId`) rehashes on any edit to the authoring module. The
  source-file spelling (`file`) changes with the resolver that compiled the
  module (labs#4772), and the runner's write-time authorization ignores it: it
  anchors on `moduleIdentity` plus the binding `path`. So the comparison holds
  only the binding `path` and the `uiContract` fixed, and the runner still
  verifies the live writer's `moduleIdentity` against the claim at write time,
  so this narrows nothing. Where the claim sits in the schema makes no
  difference to that: the checker descends every keyword that holds schemas —
  `allOf`, `oneOf`, `if`/`then`, and `not` among them — and normalizes a claim
  it finds there the same way it normalizes one written onto a property. This
  package emits none of those keywords, so nothing it produces exercises that
  today. The checker sees schemas from elsewhere as well, and holds them to the
  same reading.
- `SchemaGeneratorTransformer.resolvePolicyOfMarkers` replaces a valid policy
  marker with the compiled module identity, exported symbol, and policy digest.
  If it cannot match a compiler-verified exported `exchangeRules()` binding,
  it reports a `cfc-policy-of` diagnostic and leaves the marker unresolved.
- `uiContract` also arrives via the hints channel (§13), produced by
  `ts-transformers/src/transformers/ui-helper-lowering.ts`.

In-package coverage: `test/schema/cfc-authoring.test.ts` (13 tests), including
renamed `AnyOf` / `PolicyOf` imports, and `test/ifc-labels.test.ts` for how
labels combine. Transformer-side policy compilation and
diagnostics are pinned by `packages/ts-transformers/test/cfc-authoring.test.ts`.

The collection/opaque helpers `LengthPreservedFrom`, `FilteredFrom`,
`SubsetOf`, `PermutationOf`, and `OpaqueInput` were removed from
`@commonfabric/api/cfc`: the runner rejects those unsupported IFC keys
fail-closed. A hand-authored `Cfc<T, M>` still structurally passes through an
arbitrary record `M`; that low-level escape hatch does not make the removed
helpers part of the supported authoring surface.

The emitted key set aligns with the api's `JSONSchemaObj.ifc` member
(`packages/api/index.ts`): `confidentiality`, `integrity`,
`addIntegrity`, `requiredIntegrity`, `maxConfidentiality`, `ownerPrincipal`,
`writeAuthorizedBy`, `writePolicyAnyOf`, `exactCopyOf`, `projection`,
`observes`, and `uiContract`. `ownerPrincipal` and `observes` have no direct
producing alias in this package as of this writing.

## 12. Doc Comments → `description` / `tags` / `$comment`

- Root: JSDoc from the type's alias and/or direct symbol attaches as
  `description` when the schema lacks one (`attachRootDescription`,
  `src/schema-generator.ts`; `extractDocFromType`,
  `doc-utils.ts`).
- Properties: symbol + declaration docs; `@tag` lines stripped; among multiple
  JSDoc blocks the nearest-to-declaration wins (sorted by position descending,
  `doc-utils.ts`); conflicts keep the first + `$comment: "Conflicting
  docs across declarations; using first"` + logger warning
  (`object-formatter.ts`).
- **Declaration-file exclusion**: docs from `.d.ts` declarations are ignored
  unless the symbol also has a non-declaration-file declaration
  (`doc-utils.ts`) — lib docs do not leak into schemas.
- Index signatures and intersection constituents have their own attachment
  points (§4 table; §9).
- Hashtags in any attached description mirror into a `tags` array —
  lowercased, deduped, first-seen order (`attachDocTags`, `doc-utils.ts`
  → `extractHashtags`, `packages/data-model/src/schema-tags.ts`; api
  field `index.ts`). Fixtures: descriptions-hashtag-tags,
  descriptions-index-signature-tags, descriptions-root-with-tags.

- **`@deprecated` on a stream-valued property → `deprecated: true`** (verb
  listing marks, producer 2 — verb contract WS-F): the standard JSON Schema
  annotation, emitted only where the property schema is stream-marked
  (`symbolHasDeprecatedTag` + `attachDeprecatedStreamMark`,
  `doc-utils.ts` / `object-formatter.ts`; both the declared-`Stream` and
  callable-valued property paths). A deprecated DATA property is compat
  surface, not a verb, and stays unmarked. Annotation-class in the piece
  compat checker, so the mark adds and removes freely. The companion mark
  `tier: "wrapper"` is stamped post-generation by ts-transformers'
  `VerbTierMarkTransformer` (current-behavior spec §12.1), not here.
  Fixture: stream-deprecated-mark.

## 13. The Hints Channel (`schemaHints`)

Hint shape (`src/interface.ts`): `SchemaHints` is `WeakMap<ts.Node,
SchemaHint>`, where `SchemaHint` is `{ items?: unknown; cfcUiContract?:
UiContractHint; narrowedFrom?: NarrowedFrom; spelledBy?: ts.TypeNode }`,
`UiContractHint` is
`{ helper: "UiAction" | "UiPromptSlot" | "UiDisclosure"; action?; surface?;
role?; kind?; trustedPattern?; requiredEventIntegrity? }`, and `NarrowedFrom`
is `{ type: ts.Type; typeNode?: ts.TypeNode }`. Every member is read-only: the
generator only reads hints, and copies the `requiredEventIntegrity` list on the
way into the emitted schema. A node holds a hint of each kind, recorded apart
from the others. The producer writes `items` and `cfcUiContract` to the node
and its original (`cross-stage-state.ts`), and `narrowedFrom` and `spelledBy`
to the node alone. A `cfcUiContract` lookup tries the node and
`ts.getOriginalNode(node)` (`src/ui-contract.ts`, called from
`schema-generator.ts` and `object-formatter.ts`); an `items` lookup reads the
current hint node (`common-fabric-formatter.ts`); a `narrowedFrom` lookup reads
the node, and the node inside its parentheses (`schema-generator.ts`); a
`spelledBy` lookup reads the node (`formatChildType` in
`schema-generator.ts`).

- **`items: false`** — array-typed wrapper contents collapse to
  `items: { type: "unknown", …element wrapper markers }`, preserving the outer
  wrapper without materializing item schemas. The transformer records it on a
  handler state property whose elements the body uses only for identity. Element capability is recovered from the element
  node or type; for expanded `Default<[]> | Item[]` unions it is recovered by
  descending the synthetic union **node** to the single real array member,
  since the resolved type cannot express it (CT-1639 Gap B)
  (`common-fabric-formatter.ts`; consumed at
  `array-formatter.ts` via `context.arrayItemsOverride`,
  `interface.ts`). Tested: capability-wrapper-types ×2.
- **`cfcUiContract`** attaches `ifc.uiContract` at three layers: generation
  root (`applyNodeSchemaHints` calling the shared `attachUiContract`,
  `schema-generator.ts` / `ui-contract.ts`), the `$UI` property inside objects
  (`object-formatter.ts`), and post-hoc in the transformer
  against the emitted literal
  (`ts-transformers/.../schema-generator.ts`, preferring an
  existing `$UI` property when present).
- **`narrowedFrom`** names the value a node was built from part of, such as a
  capture narrowed to the members its callback reads. The node's schema keeps
  the value's labels: the `ifc` that formatting `type`, spelled by `typeNode`
  where given, attaches at its top, through the definitions it references,
  combined into the node's own as an outer declaration's
  (`applyNodeSchemaHints` in `schema-generator.ts`, `withIfcLabels` and
  `declaredIfcLabels` in `ifc-labels.ts`). The value is formatted apart from
  the position, in definitions of its own, with nothing reported, and only for
  its labels: a type no CFC wrapper holds, other than a union, an
  intersection, `null` or `undefined`, reads as `{}`
  (`GenerationContext.labelsOnly`). A cell has
  the labels of its value, read at the value's own node where its wrapper is
  written out. A value that may be `undefined` or `null` has the labels of its
  one other member, and where the node's schema is such a union whose value
  member declares labels of its own and the union none, they are combined into
  that member's, where formatting put the part of them it could read
  (`labeledValueMember` in `ifc-labels.ts`). Where no member node is paired
  through the value's node, as a reference to a generic alias whose body is
  the union, the value is formatted whole at that node and has the labels
  formatting attaches to its value member, unless that member is a cell. A node
  narrowed from any other union stands for any of its members, so it has the
  union's labels, every member's confidentiality, and each other label every
  member declares alike (`joinMemberIfcLabels`). A member is spelled by the
  node its type is written as: the declaration's own node where that denotes
  the member alone, as an optional property's does, and otherwise the node
  of the union the declaration writes that it is read at (§8,
  `pairUnionMemberNodes`). A node that stands for several members is read
  once for all of them, and a member several such nodes stand for may be
  under the labels of any of them. This also holds when the checker collapses
  several written CFC alternatives into one member: their confidentiality
  labels are all retained, including through optional and nullable reads.
  A member with no such node is read by its type. A schema whose own reference
  chain already holds every label is left as it is (`holdsIfcLabels`).
- **`spelledBy`** is the annotation of the member or binding a printed node
  holds the value of, where that annotation names a value binding, as
  `PolicyOf<typeof rules>` does. A print spells the binding as the structural
  type of the value it names, from which no reader can tell the binding, so
  the node is read as the annotation spells the type at hand (`#spelling` in
  `schema-generator.ts`):
  - Where the annotation denotes that type, the node is read as the
    annotation. An annotation denotes a type that is its own, or a union of
    the same members, since a union written through an alias is a type apart
    from the same union written out (`denotesSameType` in
    `src/typescript/type-node.ts`, which `readMemberAnnotation` also compares
    by).
  - Where the two differ only by the `undefined` of an optional member's `?`,
    which a reader may add to the annotation's type or take out of it, the
    node is read as the members the annotation writes other than
    `undefined`, beside `undefined` where the type at hand holds it. The
    members are those of the union the annotation writes, read through
    parentheses and aliases without type parameters (`readUnionMemberNodes`
    in `src/typescript/type-node.ts`), so each member of the type is read at
    the node that writes it. CFC nodes that stand for several members, or
    several nodes that stand for one member, follow §8's rules for retaining
    each written alternative and its policy bindings.
  - Where the annotation spells neither, the node is read as any print is,
    by the type at hand.

  The node's own hints still apply.

## 14. Options

`SchemaGenerationOptions` (`interface.ts`, plumbed at `schema-generator.ts`)
supports `onDiagnostic` for recoverable generation problems (§7),
`writerIdentityForSourceFile` for writer claims (§11),
`isDefaultLibrarySourceFile` for the program's own word on whether a
declaration file is the default library's (the transformer supplies
`program.isSourceFileDefaultLibrary`; without it, file names decide —
`src/typescript/default-library.ts`), and `widenLiterals`.
The effects of `widenLiterals` are:
(1) single literal types emit bare base types instead of one-value enums
(`primitive-formatter.ts`; bigint literals → `{ type: "integer" }`);
(2) union members that differ only in their literal values merge
recursively, keeping every other keyword (`union-formatter.ts`). It does
**not** widen all-literal unions (§8) and has no other effects.
`test/widen-literals.test.ts` pins the in-package behavior; consumer-side it is
extracted from `toSchema` options and exercised via ts-transformers' injection
paths (`ts-transformers/.../schema-generator.ts`).

## 15. Fail-Loud Inventory And Silent Degradations

Everything that throws, with source (test-pinned unless noted):

| Condition | Message (prefix) | Source |
| --- | --- | --- |
| No formatter matches a type | `No formatter found for type: …` | `schema-generator.ts` (untested) |
| `Map`/`WeakMap` | `… not JSON-serializable … Use Record<string, V> …` | `type-utils.ts` |
| `Set`/`WeakSet` | `… Use Array<T> instead.` | `type-utils.ts` |
| `Cell<Stream<T>>` | `Cell<Stream<T>> is unsupported. Wrap the stream: …` | `common-fabric-formatter.ts` |
| `Default<undefined>` (1-arg) | `Default<undefined> is unsupported; …` | `common-fabric-formatter.ts`; `union-formatter.ts` |
| `Default` arity ≠ 1..2 / missing args | `Default<T,V> requires 1 or 2 type arguments` | `common-fabric-formatter.ts`; `union-formatter.ts` |
| `DeepDefault` arity ≠ 1 | `DeepDefault<V> requires exactly 1 type argument` | `union-formatter.ts` |
| >1 `Default<>` member in a union | `Union types may contain at most one Default<> member.` | `union-formatter.ts` (indirectly tested) |
| Object default widening an object member | `Default object union member is not assignable …` | `union-formatter.ts` |
| `DeepDefault` without object target/default | `DeepDefault must be unioned with an object type …` | `union-formatter.ts` |
| `DeepDefault` unknown key | `DeepDefault key "…" does not exist on the target object type.` | `union-formatter.ts` |
| Nested scope wrappers | `Nested scope wrappers require a cell boundary between scopes.` | `common-fabric-formatter.ts` |
| Scope wrapper as a union member beside a value other than `null` or `undefined` | `A scope wrapper cannot be a member of a union.` | `common-fabric-formatter.ts`, `scope-placement.ts` |
| Scope wrapper around a cell beside anything, `null` and `undefined` included | `A scope wrapper around a cell cannot hold anything beside the cell` | `common-fabric-formatter.ts` |
| Scope wrapper beside `null` or `undefined` in a written union whose members do not read as wrappers or `null` or `undefined` | ``A scope wrapper beside `null` or `undefined` is read from the union written around it`` | `common-fabric-formatter.ts` |
| An `ifc` key other than `confidentiality` declared differently by nested wrappers, or by a `$ref` and its definition | ``One value declares `ifc.<key>` twice, as … and as ….`` | `ifc-labels.ts` |
| Circular type alias (wrapper chain) | `Circular type alias detected: A -> B -> …` | `type-utils.ts` |
| Circular type alias (union alias) | `Circular type alias detected: <name>` | `union-formatter.ts` |
| Wrapper/scope/CFC alias without type argument | `<Kind><T> requires type argument` | `common-fabric-formatter.ts` (untested) |
| Internal invariants: empty union/intersection; CommonFabric claimed-but-unformattable terminal; ArrayFormatter element-info mismatch | `… received empty … type` / `Unexpected Common Fabric type: …` / `… indicates a bug in supportsType logic` | `union-formatter.ts`; `intersection-formatter.ts`; `common-fabric-formatter.ts`; `array-formatter.ts` (all untested) |

Silent degradations: `safe*` wrappers `console.warn` and continue
(`type-utils.ts`); type parameters / conditionals → `{}` (§4);
conditional/type-parameter wrapper-union members skipped
(`common-fabric-formatter.ts`);
synthetic node resolution failure → `any` → `true`
(`schema-generator.ts`); unsupported intersections → permissive object
+ `$comment` (§9); the `{ type: "string", enum: ["unknown"] }` sentinel (§4);
`applyWrapperSemantics` with an unmappable kind returns the schema unchanged
(`common-fabric-formatter.ts`).

## 16. Known Limits And Observed Quirks

1. **Tuples lose positional structure** — no `prefixItems`/length bounds (§4);
   the empty-array-pruning safety argument (`union-formatter.ts`)
   explicitly depends on this. Sub-wart: `[string, number?]` leaks
   `"undefined"` into `items.type`. Pinned by `test/tuple-emission.test.ts`.
   Adoption note: the runner already consumes `prefixItems`
   (`cfc.ts`, traversal in `cfc/schema-refs.ts` /
   `schema-merge.ts`) and the api dialect declares it — emission here is
   the missing half, gated on the pruning-safety argument above.
2. **TS enums** — whole enum declarations hoist `{ enum: […] }` defs with no
   `type` key; individual enum-member types stay inline to avoid `$defs` name
   collisions. Pinned by `test/enum-member-hoisting.test.ts` +
   `test/enum-schema-rows.test.ts`.
3. **`widenLiterals` is incoherent at the literal-union boundary** (§14;
   pinned by `test/widen-literals.test.ts`): all-literal unions stay enums
   under the flag while the same literals DO widen inside mixed unions, and a
   single-literal property widens next to an unwidened literal-union sibling.
   Both generation entry points receive the same options. The transformer-side
   `widenLiteralType` (same name, schema-injection
   pre-widening) DOES widen literal unions — the two mechanisms disagree.
   Decide the policy (including nested enum-typed properties) before changing
   the in-package behavior.
4. **bigint → `integer` via `Number`** — silent precision loss above 2^53
   (§4, probe); untested.
5. **CFC alias detection is name-keyed**, no source check (§11); untested
   collision case.
6. **`VNode`/`JSONSchema*` lack the lib-declaration guard** (§5.2); untested.
7. **Node/type literal-encoding divergence** (`const` vs `enum`, §2).
8. **Dead cycle pre-pass** (§5.4).
9. **Stale `$schema` doc-comments** (`schema-generator.ts`); no
   code path emits `$schema` (grep).
10. **Transformer merge wart** — options spread twice, before and after
    uiContract/writeAuthorizedBy attachment
    (`ts-transformers/.../schema-generator.ts`); idempotent for
    literal options.
11. **`plugin.ts` hint-type drift** (§2).
12. **Untested helper modules** — `typescript/property-name.ts`,
    `property-optionality.ts`, `type-traversal.ts`, `wrapper-names.ts` have no
    dedicated unit tests (`test/typescript/` holds one cell-brand test);
    exercised indirectly through ts-transformers suites.
13. **Primitive fallback sentinel** (§15) — silent, mis-typed, untested.

## 17. Test Workflow

- `deno task test` from `packages/schema-generator/` (env knobs allow-listed
  in `deno.jsonc`); `deno task check` type-checks source, harnesses, and
  test suites while excluding raw fixture inputs. Those inputs depend on the
  synthetic declarations supplied by the fixture runner and are checked there.
- **Fixture runner** (`test/fixtures-runner.test.ts`): drives
  `test/fixtures/schema/*.input.ts` → `*.expected.json`; the root type is the
  fixture's `SchemaRoot`. Env knobs: `FIXTURE=<baseName>` filter;
  `UPDATE_GOLDENS=1` rewrites goldens
  (`packages/test-support/src/fixture-runner.ts`); `SKIP_INPUT_CHECK=1`
  disables the default batch type-check of all inputs in one program — type
  errors otherwise fail the suite before any comparison.
- **Normalization caveat**: goldens are normalized — object keys sorted,
  `required`/`enum` arrays sorted, nullable-`anyOf` pairs reordered null-first
  (`test/utils.ts`) — so golden JSON ordering is not emission ordering.
- Fixture inputs compile against a synthetic prelude declaring the wrapper
  interfaces with `CELL_BRAND` markers, `Reactive<T> = T`, `Writable<T> =
  Cell<T>`, and the scope wrappers (`test/utils.ts`). The prelude is its own
  file of the test program, `commonfabric.d.ts`, declared both as globals and
  as the `"commonfabric"` module, so its wrappers are `commonfabric`'s by the
  identity check in §6.1. `Default` is declared per-fixture (e.g.
  `default-type.input.ts`), relying on §7's name-based node detection.
- **Cross-package pinning**: the ts-transformers `schema-transform` and
  `schema-injection` fixture suites (ts-transformers behavior spec §12 and §20)
  exercise this package end-to-end through `SchemaGeneratorTransformer`;
  changes here surface as golden diffs there.
- In-package unit suites (as of this writing): brand-payload-defaults, plugin,
  enum-member-hoisting, enum-schema-rows, intersection-formatter,
  literal-encoding-paths, native-type-parameters, schema-generator,
  scope-wrappers, tuple-emission, widen-literals, typescript/cell-brand, and the
  `test/schema/` family
  (arrays, booleans, capability wrappers, cell types, CFC authoring, circular
  aliases, defaults ×5, factory inputs, nested wrappers, records/mapped types,
  recursion, aliases, type-to-schema, void).

## 18. Sources Of Truth

When a section above enumerates a set, the constant/function below is
canonical; update prose from it, not the other way around. Paths relative to
`packages/schema-generator/` unless noted.

| Spec content | Canonical source | Guard / note |
| --- | --- | --- |
| Formatter chain + order (§3) | `SchemaGenerator.#formatters` (`src/schema-generator.ts`) | array literal is the order; routing tests in `test/schema-generator.test.ts` |
| Core keyword mappings (§4) | `PrimitiveFormatter.getSchemaType` (`src/formatters/primitive-formatter.ts`); node table `analyzeTypeNodeStructure` (`src/schema-generator.ts`) | void-type / array-special-types tests |
| Hoisting exclusion rule (§5.1) | `getNamedTypeKey` (`src/type-utils.ts`) | recursion/shared-type/alias fixtures |
| Native leaf table + guard (§5.2) | `NATIVE_TYPE_SCHEMAS` / `LIB_DECLARED_NATIVE_TYPES` (`src/formatters/native-type-formatter.ts`) | `test/native-type-parameters.test.ts` |
| Wrapper spellings + normalization (§6.1) | `WrapperSpelling` / `WRAPPER_SPELLING_TO_KIND` (`src/typescript/wrapper-names.ts`) | compile-time exhaustiveness |
| Node-wrapper participation (§6.1, §6.4) | `NODE_WRAPPER_SPELLINGS` (`src/type-utils.ts`) | compile-time table |
| Brand values / kind↔brand maps (§6.2) | `CellBrand` / `wrapperKindToBrand` (`src/typescript/cell-brand.ts`) | capability-wrapper-types tests |
| Capability-kind subset (§6.3) | `CELL_CAPABILITY_KIND_MAP` (`src/formatters/common-fabric-formatter.ts`) | exhaustive over `CellWrapperKind` |
| `asCell` entry shape (§6.2, §10) | `AsCellEntry` / `CellKind` / `SchemaScope` (`packages/api/index.ts`) | — |
| Scope wrapper map (§10) | `SCOPE_WRAPPER_SCOPES` (`src/formatters/common-fabric-formatter.ts`) | scoped-wrappers fixture |
| CFC alias set (§11) | `CFC_CANONICAL_ALIAS_NAMES` (`packages/api/cfc.ts`) | — |
| CFC payload map (§11) | `buildIfcMetadataForAlias` switch (`src/formatters/common-fabric-formatter.ts`) | cfc-authoring tests |
| `ifc` key vocabulary (§11) | `JSONSchemaObj.ifc` (`packages/api/index.ts`) | — |
| Hint shape (§13) | `SchemaHint` / `UiContractHint` (`src/interface.ts`) | — |
| Generation options (§14) | `SchemaGenerationOptions` (`src/interface.ts`) | widening, writer identity, and diagnostics |
| Throw inventory (§15) | grep `throw new Error` under `src/` | messages quoted above verified this snapshot |
| Fixture env knobs (§17) | `test/fixtures-runner.test.ts`; `packages/test-support/src/fixture-runner.ts` | — |

A drift-resistant habit (mirroring the ts-transformers spec §21.1): when
editing a set above, update this document from the canonical source and keep
prose lists labeled "as of this writing."
