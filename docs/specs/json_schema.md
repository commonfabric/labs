# JSON Schema

Our system uses the JSON Schema standard, specifically the 2020-12
[core](https://json-schema.org/draft/2020-12/json-schema-core) and
[validation](https://json-schema.org/draft/2020-12/draft-bhutton-json-schema-validation-01)
specifications.

Many cells are linked together in complex graphs. Since clients typically don't
need all reachable cells, schemas serve as filters to limit what data is
returned.

We also automatically convert TypeScript types to JSON Schema as part of our
pattern compilation workflow.

Due to its specialized role in our system, we handle these schemas differently
from standard implementations in several ways.

## Extensions

We add several custom fields to the schema that are meaningful to our system.
The authoritative field inventory is the `JSONSchema` type in
`packages/api/index.ts`; this section summarizes, it does not define.

- **`asCell`**: an **array** of wrapper entries describing how the value is
  held rather than stored inline. Entries name the wrapper kind — for example
  `asCell: ["cell"]` (a link to a cell holding the data), `asCell: ["stream"]`
  (a stream interface for connecting events to listeners), or
  `asCell: ["opaque"]` (pass-through-only). Nesting composes:
  `Cell<Cell<T>>` becomes `asCell: ["cell", "cell"]`. See `AsCellType` in
  `packages/api/index.ts` for the entry shape, and
  [Streams](#streams-are-declarations-not-views) for the one entry that is not
  a view onto a value. (A separate boolean-style `asStream` field existed
  historically; it is no longer part of the type and is not emitted — a couple
  of runner utilities still tolerate it on stored data.)
- **`scope`**: storage-partition selector emitted for `PerSpace<T>` /
  `PerUser<T>` / `PerSession<T>` wrappers.
- **`tier`**: verb listing mark on stream properties. `tier: "wrapper"` names
  a UI affordance outside the headless contract, inferred at compile time
  from session-scoped handler bindings plus a void event
  (ts-transformers current-behavior spec §12.1). `cf piece verbs` hides
  marked verbs by default; everything stays callable, and `cf piece call`
  never consults the mark. Annotation-class in the piece compat checker
  (adds and removes freely). Standard `deprecated: true` is the companion
  mark on the other axis, produced from `@deprecated` JSDoc.
- **`ifc`**: Information Flow Control (IFC) annotations (see [IFC](#ifc))

### Streams are declarations, not views

`asCell: ["cell"]` is a flag about how the value beside it is handed over. The
rest of the schema still describes that value and still filters it; a reader
that drops the flag reads the same data inline.

`asCell: ["stream"]` is not that kind of flag. It says what the position is —
a stream, which holds no value — so the keywords beside it describe the event
a `send()` carries, not something readable at the position. The marker stands
in front of the event schema rather than combining with a description of the
position's own value, and the two do not compose: a schema cannot declare a
stream and a readable value at the same place.

### IFC

The `ifc` extension attaches Information Flow Control metadata to schema
nodes. The key set is defined by the `ifc` field of the `JSONSchema` type in
`packages/api/index.ts` — as of this writing: `confidentiality`, `integrity`,
`addIntegrity`, `requiredIntegrity`, `maxConfidentiality`, `ownerPrincipal`,
`writeAuthorizedBy`, `exactCopyOf`, `projection`, `observes`, and `uiContract`.
The compile-time side (CFC authoring aliases and UI helpers
lowering to these keys) is specified in
`docs/specs/ts-transformer/cfc_authoring_contract.md` and
`docs/specs/ts-transformer/cfc_ui_helper_contract.md`; the label semantics live
in the CFC spec (specs repo, `cfc/`).

```json
{
  "type": "string",
  "ifc": { "confidentiality": ["secret"] }
}
```

## Special Handling of additionalProperties

The `additionalProperties` field in JSON Schema objects defaults to `true`, but
our system treats this field as having three distinct states:

- **`true`**: Follow additional properties (those not explicitly defined in the
  schema) to find other linked cells
- **`false`**: Don't follow additional properties and don't include linked cells
  from the current object
- **undefined** (not specified): Follow only the properties explicitly defined
  in the schema

### Example

Consider a cell with the following contents:

```json
{
  "country": "United States",
  "postalCode": { "/": "baed...0002" }, // link to cell2
  "state": { "/": "baed...0003" } // link to cell3
}
```

**When `additionalProperties` is `false`:**

```json
{
  "type": "object",
  "properties": {
    "country": { "type": "string" },
    "postalCode": { "type": "string" }
  },
  "additionalProperties": false
}
```

Result: We include the queried node but exclude cell2 and cell3.

**When `additionalProperties` is `true`:**

```json
{
  "type": "object",
  "properties": {
    "country": { "type": "string" },
    "postalCode": { "type": "string" }
  },
  "additionalProperties": true
}
```

Result: We include the queried node plus both cell2 and cell3.

**When `additionalProperties` is not specified:**

```json
{
  "type": "object",
  "properties": {
    "country": { "type": "string" },
    "postalCode": { "type": "string" }
  }
}
```

Result: We include the queried node plus cell2, but exclude cell3.

## Combining Schemas

When traversal follows a link, the schema from the current query takes
precedence over the schema embedded in the link (`combineSchemaForLink`,
gated by the `readerSchemaPrecedence` experimental flag, default on). The
reader's schema is used as it stands, and the link's schema is adopted only
where the reader is agnostic: a true or empty reader schema adopts it under
the reader's own `asCell` wrapper, and a false reader schema stays false. A
link routinely describes — and requires — more of its target than the
reader asked for, and none of that reaches the combined schema: a property
or `required` entry declared only by the link does not survive a shaped
reader, and a `false` link schema blocks only readers that brought no shape
of their own.

`default` is the exception: a value's default is inherited from the last
crossed schema that declares one, so a link's top-level `default` overrides
earlier links' and the reader's own, and the reader's stands where no link
declares one.

The strict pseudo-intersection (`combineSchema`) remains in use for merging
a compound schema's base keywords with its own `anyOf`/`oneOf` branches.
There, properties and `required` fields from either side survive, shared
properties combine recursively, and the three `additionalProperties` states
above stay distinct: an absent `additionalProperties` does not prohibit a
property declared only by the other side, an explicit
`additionalProperties: false` rejects such one-sided properties, and `true`
permits them.

See [Link-schema precedence](link-schema-precedence.md) for the
consolidated specification, and
[Schema Narrowing in the Memory v2 query specification](memory-v2/05-queries.md#534-schema-narrowing)
for the rules in the query pipeline's context, including the rollback flag
and the cfc-relevance marking that stays independent of the combination.

## What each operation supports

How much of the vocabulary is implemented depends on which operation is asking.
Two operations ask different questions of a schema, and they answer to different
subsets of it.

**Traversal** is a filter. It decides which linked cells a read loads and which
properties come back, so it implements the keywords that shape a value and
ignores the ones that only accept or reject a whole value. It follows `$ref`,
`anyOf`, `oneOf`, `allOf`, `properties`, `additionalProperties`, `items` and
`prefixItems`, and it checks `type` and `required`. It does not check
`maxProperties`, `uniqueItems`, `enum` or `const`, and a value violating one of
those reads back unchanged. It does not follow `patternProperties` either: a
property whose only description is a pattern is neither shaped by that pattern
nor admitted by it through a closed object.
[Traversal](space-model/8-traversal.md) is the specification, including how
`anyOf`, `oneOf` and `allOf` branch results are merged, which is
runtime-specific rather than standard. Narrowing a schema across a path
boundary can be more permissive than standard semantics, for the reason
[Schema Narrowing](#schema-narrowing) gives below.

**Validation** answers whether a value satisfies a schema, and it is the
operation a verb call's payload, a pattern's structured result, and a stored
argument are measured by. It implements nearly the whole 2020-12 vocabulary:
`allOf`, `anyOf`, `oneOf`, `not`, `if`, `then`, `else`, `enum`, `const`,
`contains`, `maxContains`, `propertyNames`, `dependentSchemas`,
`dependentRequired`, `maxProperties`, `uniqueItems` and `patternProperties` are
each enforced. Two keywords are not: `unevaluatedProperties` and
`unevaluatedItems` are accepted and never applied, so a schema relying on one
of them constrains nothing. `contentSchema` is refused rather than ignored —
validating it reports that content validation is not supported.

The gap between the two matters where a value crosses from one to the other. A
value that reads back through traversal is not thereby a value validation
accepts. Traversal ignores some keywords entirely, so a schema built only from
those rejects nothing until something validates against it.

## TypeScript Type Mappings

TypeScript includes `never`, `void`, and `undefined` types that don't map
directly to JSON Schema.

### Handling of `undefined`

- In objects: Properties with `undefined` values are removed entirely (both key
  and value)
- In arrays: `undefined` values are replaced with `null`

### Handling of `void`

`void` is primarily a function-return type, but when it does reach schema
generation it is emitted as `{ "asCell": ["opaque"] }` — the value matches
anything and will not be accessed.

### Non-standard `type` values

Deliberate extensions beyond the 2020-12 vocabulary:

- `{ "type": "unknown" }` — emitted for TypeScript `unknown` and for
  unresolved/degraded generics. Distinct from `true` (which is what `any`
  becomes): `unknown` declares a REFERENCE, `any` means "accept anything". A
  read stops at an `unknown` position rather than descending: it yields
  something truthy that compares by identity and writes back as a link, and
  that carries none of what it names. A concrete type declared beside it, as in
  `{ "type": ["unknown", "string"] }`, is a reader asking for the value and
  gets it.
- `{ "type": "undefined" }` — preserved as an explicit union member (e.g.
  `string | undefined`) so optionality survives schema round-trips.
- `FabricPrimitive` types — `"FabricBytes"`, `"FabricEpochDay"`,
  `"FabricEpochNsec"`, `"FabricHash"`, `"FabricKeyPair"`, `"FabricRegExp"`,
  `"FabricUnavailable"` — each naming a
  concrete `FabricPrimitive` class from the data-model. A value matches by
  prototype (`instanceof`), not by structure: these values are opaque leaves
  with no enumerable properties, and they are never property-walked.
  Each `FabricPrimitive` type is a subtype of `"object"` (the way `"integer"`
  is a subtype of `"number"`): a `FabricBytes` value satisfies both
  `{ "type": "FabricBytes" }` and `{ "type": "object" }`, while a plain
  object satisfies only the latter. One structural keyword gates the subtype
  match: an object-typed schema's `required` keys must exist on the
  primitive, where class accessors count (`FabricBytes` satisfies
  `required: ["length"]` but not `required: ["x"]`) — mirroring the
  TypeScript structural rule that a `FabricBytes` is assignable to
  `{length: number}`. The nominal brand key (`FABRIC_SPECIAL_OBJECT_BRAND` in
  `packages/runner/src/fabric-special-object-brand.ts`), which schemas from
  pre-vocabulary compilations name in `required` (current generator emissions
  omit it everywhere), has no runtime existence and counts as present on any
  `FabricSpecialObject`. Property sub-schemas are
  still not walked against a primitive: presence is checked, shapes are not, so
  `{ "type": "object", "properties": { "source": { "type": "number" } } }`
  matches a `FabricRegExp` even though its `source` is a string. Schemas
  generated from the real class types cannot express such a mismatch; only
  hand-written schemas can, and they get no shape enforcement on opaque
  leaves. Each name is the one its class's instances report as `.schemaType`,
  and no list of them is written out: the type `FabricPrimitiveSchemaType`
  (`packages/data-model/src/api.ts`, which `@commonfabric/api` re-exports) is
  derived from the class declarations there, and the runtime list
  `FABRIC_PRIMITIVE_SCHEMA_TYPES`
  (`packages/data-model/src/fabric-primitives/impl.ts`) from the classes.

A generated schema places each named type in its root `$defs` and refers to
it by `#/$defs/<name>`. The full TypeScript→schema mapping is specified in
the schema-generator mapping spec (`docs/specs/schema-generator/`).

A `#/$defs/<name>` ref names a definition of the document root, as JSON
Schema resolves it. The runtime supports no keyword that starts another
resource below the root (`$id`, `$anchor`, and the dynamic-ref keywords are
refused), so a `$defs` on a subschema is inert. Only an embedded or `cid:`
external ref enters another document, whose own map governs everything below
it; `docs/specs/content-addressed-schemas.md` gives the `cid:` form. A
fragment evaluated apart from its document carries a copy of the document's
map, which opens no scope of its own.

### Handling of `never`

The `never` type is commonly used in scenarios like rejecting invalid
properties:

```typescript
type User = {
  id: number;
  name: string;
  email?: string;
  // This property should never exist
  password?: never;
};
```

We express this pattern in JSON Schema as:

```json
{
  "type": "object",
  "properties": {
    "id": { "type": "number" },
    "name": { "type": "string" },
    "email": { "type": "string" },
    "password": false
  },
  "required": ["id", "name"]
}
```

The `never` type is also used for ensuring objects have no properties:

```typescript
type EmptyObj = Record<string | number | symbol, never>;
```

This translates to:

```json
{
  "type": "object",
  "additionalProperties": false
}
```

## Schema Narrowing

We sometimes derive schemas from larger schemas, such as when accessing a field
of one cell as another cell.

### Example

Starting with a contact entry schema:

```json
{
  "type": "object",
  "properties": {
    "address": {
      "type": "object",
      "properties": {
        "postOfficeBox": { "type": "string" },
        "extendedAddress": { "type": "string" },
        "streetAddress": { "type": "string" },
        "locality": { "type": "string" },
        "region": { "type": "string" },
        "postalCode": { "type": "string" },
        "countryName": { "type": "string" }
      },
      "required": ["locality", "region", "countryName"]
    },
    "name": { "type": "string" },
    "phoneNumber": { "type": "string" }
  }
}
```

When accessing the cell's `address` field, we narrow the schema to just that
portion:

```json
{
  "type": "object",
  "properties": {
    "postOfficeBox": { "type": "string" },
    "extendedAddress": { "type": "string" },
    "streetAddress": { "type": "string" },
    "locality": { "type": "string" },
    "region": { "type": "string" },
    "postalCode": { "type": "string" },
    "countryName": { "type": "string" }
  },
  "required": ["locality", "region", "countryName"]
}
```

### Complications with Core Logic

Schema narrowing becomes complex when using operations like `anyOf`. For
example, if you want to ensure every contact has either an address with a
`streetAddress` OR a `phoneNumber` on the main contact, you might use `anyOf`
where the first clause requires `phoneNumber` but not `streetAddress`, and the
second clause requires `streetAddress` but not `phoneNumber`.

However, when narrowing to just the address portion, we lose the context of how
fields outside the narrowed schema affect the validation logic. The resulting
narrowed schema may be more permissive than intended.

This isn't problematic for our design since the schema still fulfills its
primary role of limiting linked cells and field access, even when more
permissive than expected.

### Complex Example

**Top-level schema:**

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "address": {
          "type": "object",
          "properties": {
            "streetAddress": { "type": "string" },
            "locality": { "type": "string" },
            "region": { "type": "string" },
            "countryName": { "type": "string" }
          },
          "required": ["locality", "region", "countryName"]
        },
        "name": { "type": "string" },
        "phoneNumber": { "type": "string" }
      },
      "required": ["name", "phoneNumber", "address"]
    },
    {
      "type": "object",
      "properties": {
        "address": {
          "type": "object",
          "properties": {
            "streetAddress": { "type": "string" },
            "locality": { "type": "string" },
            "region": { "type": "string" },
            "countryName": { "type": "string" }
          },
          "required": ["streetAddress", "locality", "region", "countryName"]
        },
        "name": { "type": "string" },
        "phoneNumber": { "type": "string" }
      },
      "required": ["name", "address"]
    }
  ]
}
```

**Derived narrowed schema for the `address` field:**

```json
{
  "anyOf": [
    {
      "type": "object",
      "properties": {
        "streetAddress": { "type": "string" },
        "locality": { "type": "string" },
        "region": { "type": "string" },
        "countryName": { "type": "string" }
      },
      "required": ["locality", "region", "countryName"]
    },
    {
      "type": "object",
      "properties": {
        "streetAddress": { "type": "string" },
        "locality": { "type": "string" },
        "region": { "type": "string" },
        "countryName": { "type": "string" }
      },
      "required": ["streetAddress", "locality", "region", "countryName"]
    }
  ]
}
```
