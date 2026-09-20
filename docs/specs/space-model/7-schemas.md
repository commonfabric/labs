# Schemas

This document specifies how data types are described and used.

## Status

Draft — based on codebase investigation and design discussion.

---

## Current State

### Overview

Schemas describe the shape and type of data in cells. The system uses JSON
Schema as the description language, with extensions for cell-specific behavior.

### JSON Schema as Type Language

Standard JSON Schema properties are used:
- `type`: "string", "number", "boolean", "object", "array", "null"
- `properties`: object property schemas
- `items`: array element schema
- `default`: default value
- `required`: required properties

### Special Schema Properties

#### `asCell: ["cell"]`

Marks a property as a cell reference rather than inline data:

```json
{
  "type": "object",
  "properties": {
    "linkedItem": { "asCell": ["cell"], "type": "object" }
  }
}
```

#### `asCell: ["stream"]`

Marks a property as a stream endpoint:

```json
{
  "type": "object",
  "properties": {
    "onClick": { "asCell": ["stream"] }
  }
}
```

This causes:
- No stored value: the declaration alone marks the position
- Different runtime behavior (send vs set)
- Different change detection (every send triggers)

#### `default`

Provides default values:

```json
{
  "type": "object",
  "properties": {
    "count": { "type": "number", "default": 0 }
  }
}
```

### Schema-Driven Behavior

Schemas influence runtime behavior:
- **Validation and transformation**: Schema-aware traversal resolves references
  and shapes data. Non-conforming values are rejected: required properties that
  don't match return `undefined` at the top level (and `null` for array elements
  where null is allowed). Optional properties that don't match are simply
  absent. A schema that cannot be read at all — a `$ref` naming a definition it
  does not carry — matches nothing, rather than being treated as the absence of
  a schema and letting every value through. An eager read therefore returns
  either a valid value or `undefined`. A read under lazy materialization decides
  the same questions where the reader touches them, so it has a third outcome: a
  mismatch under a `required` property throws a `SchemaMismatchError` at that
  access. The runner disposes of one as an argument that did not resolve — an
  undefined result, not a fault — which is what an eager read's `undefined`
  produces anyway.
- **Cell creation**: `asCell: ["cell"]` properties become cell references
- **Stream declaration**: `asCell: ["stream"]` properties get event semantics

### Schema Resolution

Schemas can be:
- Explicitly provided when creating cells
- Inherited from result-cell metadata links
- Inferred from values (limited)

---

## Proposed Directions

### Removing the stream declaration

The `asCell: ["stream"]` declaration encodes type information in a schema
property rather than in the data itself. This creates:
- Two parallel type systems (schema types + stream/cell bifurcation)
- Method duplication (get/set vs send)
- Runtime brand checking (isStream)

#### Alternative: Timestamps in Schema

Instead of a declaration, events could be data that includes timestamps:

```json
{
  "type": "object",
  "properties": {
    "x": { "type": "number" },
    "y": { "type": "number" },
    "timestamp": { "type": "number" }
  }
}
```

The "event-ness" emerges from the data shape:
- Values with different timestamps are different values
- Change detection works normally
- No special flags or bifurcated runtime behavior

#### What This Eliminates

- The `asCell: ["stream"]` declaration
- `isStream()` / `isCell()` checks
- Separate Stream type
- Duplicated methods (send vs set)

#### What This Requires

- Convention for timestamp fields
- Event producers include timestamps
- Or: system adds timestamps if schema indicates it

---

## Open Questions

- Should the stream declaration be removed in favor of timestamp-based events?
- How are schema migrations handled?
- What is the validation behavior on schema mismatch?
- How do schemas interact with the type system in pattern code?
- Should schemas be versioned?

---

**Previous:** [Reactivity](./6-reactivity.md) | **Next:** [Traversal and Schema Query](./8-traversal.md)
