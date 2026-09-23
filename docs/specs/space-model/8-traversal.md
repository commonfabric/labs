# Traversal and Schema Query

This document specifies the current behavior of the traversal subsystem implemented
in `packages/runner/src/traverse.ts`.

## Status

Draft — normative for current runner behavior.

---

## Scope

This spec covers:

- Value/path traversal (`getAtPath`, `followPointer`)
- Schema-aware traversal (`SchemaObjectTraverser`)
- Link and write-redirect handling during reads
- Missing value/default handling
- Dependency tracking side effects (`schemaTracker`)

It does not specify write-time mutation behavior.

---

## Core Model

Traversal operates on attestations of the form:

- `address`: `{ space, id, type, path }`
- `value`: current datum at that address (or `undefined` if missing)

Path conventions:

- Address paths are rooted under `"value"`
- Link paths are relative and do not include `"value"`
- Array indices must be canonical decimal index strings (`"0"`, `"1"`, ...); non-index properties (for example `"01"`) are not treated as array indices

---

## Path Traversal

`getAtPath(tx, doc, path, ..., lastNode)` resolves a `doc` + relative `path` by:

1. Following links when required by `lastNode`:
   - `"value"`: follow all links
   - `"writeRedirect"`: follow only write-redirect links at terminal positions
   - `"top"`: do not follow terminal link
2. Descending object/array/string-native properties (`length` support for arrays and strings)
3. Returning `{ value: undefined }` when descent fails

When links are followed, schema context is re-rooted and combined with any schema on the link.

---

## Link Resolution and Missing Data

`followPointer(...)`:

- Resolves one pointer step, then delegates further descent back to `getAtPath`
- Detects pointer cycles using `(pointer value, schema-context)` tracking
- Records traversed linked docs in `schemaTracker`
- Returns `undefined` for missing/retracted targets instead of throwing

If `includeSource` is set, traversal also loads linked `source` and linked pattern docs recursively for dependency tracking.

---

## Schema Traversal Semantics

`SchemaObjectTraverser.traverse` evaluates a doc against a selector `{ path, schema }`.

### Boolean/true-ish schemas

- True-ish schema (`true` or object containing only internal/default metadata) traverses as DAG and returns all reachable content (subject to cycle protection)
- False schema rejects

### Logical schema operators

Every branch is evaluated against the whole value, and the branches that
succeed are merged into one result (`objectCreator.mergeMatches`). How many
must succeed is what separates the three:

- `anyOf`: at least one branch must match; every branch that does contributes to the merged result
- `oneOf`: exactly one branch must validate; zero or multiple matches reject
- `allOf`: every branch must validate, and one that fails fails the node. An `allOf` holding no branches is passed over, leaving the keywords beside it to decide the node

#### Sibling keywords

The keywords beside a combinator are merged into each branch before that
branch is evaluated (`mergeSchemaOption`), and the branch's own keywords win.
The merge is shallow, so a branch declaring `properties` replaces the sibling
`properties` map rather than adding to it.

What a branch inherits by not restating decides what it admits. A sibling
`additionalProperties: false` rides into every branch, so under one a branch
admits a key only by naming it in `properties` or by restating
`additionalProperties` itself — a branch of `true` restates nothing and so
admits nothing — and a key no branch admits is absent from the merged result.

This is a different composition from the one the entry points in `schema.ts`
use to narrow a compound schema against a concrete value
(`resolveSchemaForValue`, and the `asCell` candidates behind
`asCellCompoundSchemaForValue`). Those combine base and branch through the
strict pseudo-intersection `combineSchema`, where properties and `required`
from either side survive; see
[Combining Schemas](../json_schema.md#combining-schemas).

#### Merging branch results

`mergeAnyOfMatches` is a union rather than an intersection: a property any
surviving branch produced is in the result. A branch naming `name` while
ignoring `address`, beside one naming `address` while ignoring `name`, gives a
result carrying both — which is what keeps one branch's silence from hiding
another branch's data.

- Two or more matches merge only when each is a non-array record a walk may read by name. Otherwise the first match is the result and the rest are dropped, which is what keeps a special value — one carrying no properties for the merge to copy — from being lost
- Keys are copied in branch order, so the last branch to produce a key decides its value. `anyOf` evaluates the branches carrying no `asCell` ahead of those that do, so a cell-bearing branch's value wins such a collision
- A value projected from an opaque position carries nothing of what it names, so it never displaces a key another branch materialized, whichever order the two came in
- The merged value is a fresh object, and the matches' symbol-keyed annotations are carried onto it, the first match to define one winning. Every match describes the same position, so the merged value still names the position it was read from — without them it would compare unequal to that position and write back as an inline copy. The opaque marker is not carried: it describes the match it came from rather than the merge

The two object creators part over cells. A runtime transform whose matches
include a `Cell` returns that cell rather than a merged object, since merging
would produce a plain object and lose the cell. It re-points the cell at the
whole compound schema with the branches' own `asCell` markers removed, so the
union survives on the cell's schema and governs what a read through it
returns — with one exception. A branch that declares `asCell` and constrains
nothing is a true reader, and a true reader adopts the schema of the link it
crosses, so a handle minted from such a branch already carries the link's own
schema. The merge cannot see which branch minted the handle it holds, so the
handle keeps that schema rather than the union only where every branch that
can mint one — through nested combinators and resolved references, each read
with the keywords beside its combinator merged in as traversal merges them —
is such a bare branch, an `allOf` counting where its other parts are true; the
union says only what the reader admits. One shaped `asCell` branch anywhere in
the compound, a bare arm under an enclosing `type` and `properties` included,
keeps the union on the handle. Query traversal produces no cells, and merges
by the rules above.

### `$ref`

Top-level `$ref` is resolved before traversal decisions. Defaults are applied from the resolved schema.

A `$ref` that does not resolve — it names a definition the schema does not carry — matches nothing. Traversal fails the schema rather than treating it as absent, and so does the entry point that resolves a read's schema before traversal (`resolveSchema` in `schema.ts`). A `$ref` resolving to the boolean `true` or `false` is a resolution, not a failure to resolve, and means what the boolean means.

### Type and structure rules

- Primitive values validate against schema type
- Arrays validate per item schema
- Objects validate per property schema
- Required properties must be present in the filtered result
- When an explicit property schema rejects a value, an optional property is
  omitted from the filtered result, while a required property causes the
  containing object to reject. In particular, an optional `false` property
  excludes a link without loading or tracking its target; making that property
  required makes the object unsatisfiable when the property is present.

`additionalProperties` handling is intentionally specialized:

- If `properties` exists and `additionalProperties` is omitted, unspecified properties are not traversed; inclusion is delegated to `objectCreator.addOptionalProperty`

---

## Missing Values and Defaults

Behavior is intentionally asymmetrical:

- Missing object property reached through traversal:
  - included as `undefined` only when schema permits it
  - otherwise omitted/rejected depending on context
- Missing array entry reached through traversal:
  - may become `null` when schema allows `null`
  - otherwise causes array validation failure

Defaults:

- Property defaults are applied from schema during object traversal
- Top-level defaults are applied when current value is `undefined`
- Defaults behind resolved `$ref` are honored

---

## asCell Boundaries

`SchemaObjectTraverser.hasAsCell(schema)` controls boundary behavior.

- With `traverseCells = false` (runtime transforms), ordinary `asCell`
  boundaries produce cell/stream objects without deep traversal of nested
  content.
- With `traverseCells = true` (query traversal), ordinary `asCell` content is
  traversed to register dependencies.
- `asCell: ["opaque"]` is a hard boundary in both modes. Inline values are not
  descended into; pointer targets are not loaded, traversed, or added to
  `schemaTracker`.

### Detection Rules

`hasAsCell(schema)` is true when:

- schema object has `asCell` property
- or schema has `anyOf` and every option matches `hasAsCell`
- or schema has `oneOf` and every option matches `hasAsCell`

Notes:

- This check is shallow for `anyOf`/`oneOf` options; refs inside options are not fully resolved before this check.
- This check determines traversal boundary behavior, not whether final output is a JS Cell object. Output shape still depends on the active `objectCreator`.

### Behavior by Value Shape

| Value shape | `traverseCells = false` (runtime transform path) | `traverseCells = true` (query path) |
| --- | --- | --- |
| Primitive value with `asCell/asStream` | Boundary at current node. Traverser calls `createObject(link, value)` and does not descend. In runtime object creator this yields a cell-like wrapper. | No boundary shortcut from `traverseCells`; traversal still resolves value normally and query object creator returns plain traversed data. |
| Any value with `asCell: ["opaque"]` | Hard boundary before nested traversal. Produces the runtime's opaque cell representation. | Same hard boundary. The query object creator preserves the raw inline value or pointer; linked targets are neither loaded nor tracked. |
| Object property, inline non-link value, schema has `asCell` | Boundary at property. Property value is replaced by `createObject(propertyLink, undefined)` and nested fields are not traversed. | No boundary shortcut; traverses/validates nested object content. |
| Object property, link value, schema has `asCell` | Follows write redirects to stable target, then creates boundary object from resolved link (`getNextCellLink` path). | Follows redirects and continues traversal into resolved target content. |
| Array element, link value, schema has `asCell` | Resolves write redirects first, then follows one additional link step for array semantics, then emits boundary object for the resolved target link. | Performs same link resolution, then continues schema traversal into the resolved element value. |
| Array element, inline non-link object, schema has `asCell` | Boundary at element index. Emits `createObject(indexLink, undefined)`; no nested traversal for element fields. | No boundary shortcut; element object is traversed against element schema. |
| Array element, inline non-link object, schema is not `asCell` | Element is wrapped via data-cell URI identity (`createDataCellURI`) for stable link identity during nested traversal. | Same behavior. |

### Pointer and Redirect Details at Boundaries

For a pointer whose first `asCell` entry is `"opaque"`, traversal calls the
active object creator at the boundary before resolving write redirects or
reading the target. Runtime transforms produce an opaque cell representation;
query traversal preserves the raw pointer. This rule applies in both modes.

For ordinary, non-opaque `asCell` pointer values, runtime boundary behavior is
based on the write-redirect-resolved document:

1. Resolve only write-redirect links (`lastNode = "writeRedirect"`).
2. If runtime boundary mode (`traverseCells = false`) and schema is `asCell`, compute cell link from that resolved location:
   - if resolved value is still a link, follow one more link (`getNextCellLink`)
   - else use normalized link to current resolved address
3. Return `createObject(cellLink, undefined)`.

Broken redirect case:

- If a non-opaque redirect target is `undefined` and schema is `asCell`,
  traversal returns an error/invalid result (no boundary object is emitted).
- An opaque pointer's target is not read, so its existence is not validated at
  the boundary.

### Missing Values and Defaults at `asCell` Paths

- Missing linked value + non-opaque `asCell`: treated as invalid for boundary
  creation.
- Opaque pointer targets are not read and therefore are not checked for a
  missing value.
- Property defaults with `asCell`:
  - when a property schema default exists, traversal enters `traverseWithSchema({ value: undefined }, propSchema)`
  - default application uses the resolved schema, including defaults behind top-level `$ref`
  - emitted value is produced by `objectCreator.applyDefault` / `createObject`, so runtime and query outputs differ by object creator behavior

---

## Cycle and DAG Rules

Traversal uses cycle trackers to avoid infinite recursion across:

- Pointer/link cycles
- Object graph cycles/aliases

For `CompoundCycleTracker`, disposal removes empty per-key entries.

---

## Known Non-Standard JSON Schema Behavior

Traversal is intentionally not a full JSON-Schema validator. Notable differences:

- Branch result merging (`anyOf`/`allOf`) is a union of what the surviving
  branches produced, and the keywords beside a combinator are merged into
  each branch shallowly rather than intersected; both are described under
  [Logical schema operators](#logical-schema-operators) above
- Parent/link schema composition on reference hops (`combineSchemaForLink`) is
  precedence, not intersection: the reader's schema is used as it stands, and
  the link's schema is adopted only when the reader's is true or empty (a
  false reader schema stays false); `default` is the exception, inherited
  from the last crossed schema that declares one; a discarded link schema's
  `ifc` does not ride onto the result — the read entry point and the
  traversal's link hops mark cfc relevance off the link schemas directly
  instead
- Narrowing across path boundaries may be more permissive than strict JSON-Schema semantics

---

## Conformance Tests

Behavior in this spec is verified by:

- `packages/runner/test/traverse.test.ts`
- `packages/runner/test/query.test.ts`
- `packages/runner/test/schema-view.test.ts`

These include regression tests for:

- oneOf exact-match semantics
- allOf branch-result merging
- the sibling-keyword merge into combinator branches, under a schema that
  refuses the properties it does not name
- defaults via resolved `$ref`
- cycle-tracker cleanup

---

**Previous:** [Schemas](./7-schemas.md)
