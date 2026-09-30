# 01 — Data Model

> Editorial note: sections 02-05 now define the authoritative seq-addressed JSON
> storage, commit, and sync model. This file still contains older
> content-addressed terminology in some subsections and needs a follow-up pass
> to align its fact/reference language with the newer revision-based model.

This section defines the core data types of Memory v2: entities, facts,
references, blobs, patches, and snapshots. Every concept is accompanied by its
TypeScript type definition.

Unless a subsection is explicitly talking about pure JSON schema/query syntax,
runtime payloads in the current implementation should be read as
`FabricValue`, not plain `JSONValue`. `FabricValue` is the shared value
surface from the data-model layer: it includes ordinary JSON values plus the
extra leaves the runtime supports, such as `bigint`, `undefined`, and the
escaped single-slash object forms used by the boundary codec.

---

## 1. Entities

An **entity** is the fundamental unit of mutable state. Each entity is
identified by a URI and holds a storable value that evolves over time through a
causal chain of facts.

```typescript
/**
 * Entity identifier. URI format, e.g. "urn:entity:abc123".
 * Unique within a space.
 */
type EntityId = `${string}:${string}`;
```

Key properties:

- An entity has **at most one current value** per branch (see §06 Branching).
- An entity's full history is the ordered sequence of facts referencing it.
- Entities are **untyped at the storage layer** — there is no MIME-type or `the`
  dimension. Type information lives in schemas, which are external to the fact
  store. This is a deliberate simplification over v1, where every fact carried a
  `the` (MIME type) field alongside its `of` (entity id).
- An entity that has never been written to is in the **Empty** state. The Empty
  state is represented by a well-known sentinel reference (see §3 References).

### 1.1 Entity Document Structure

Entity values are stored in an **envelope** with well-known top-level keys:

```typescript
// Shown at module scope.
type SigilLink = {
  "/": {
    "link@1": {
      id?: `of:${string}` | `cid:${string}`;
      path?: string[];
      space?: string;
    };
  };
};

type InternalManifestEntry = {
  partialCause: FabricValue;
  link: SigilLink;
};

interface EntityDocument {
  value?: FabricValue; // The cell's data when present.
  source?: EntityRef; // Serialized short-link form {"/":"<short-id>"} -> resolves to of:<short-id> in same space.
  pattern?: SigilLink; // Well-known metadata link to a pattern cell.
  argument?: SigilLink; // Well-known metadata link to an argument cell.
  internal?: InternalManifestEntry[]; // Manifest of derived internal cells.
  result?: SigilLink; // Well-known metadata link back to a result cell.
  schema?: FabricValue; // Optional schema metadata.
  slug?: string; // Optional URL/address metadata.
  [key: string]: FabricValue;
}
```

The implementation no longer defines separate `SourceLink` or
`EntityDocumentField` types: `source` is an `EntityRef` (whose serialized
short-link form is `{"/":"<short-id>"}`), and an arbitrary document field is
just a `FabricValue` (which already subsumes the short-link, sigil-link, and
`undefined` cases above).

The `value` property holds the cell's actual data. Storing it under a key
(rather than as the top-level value) lets the envelope carry sibling metadata
like `result`, `schema`, or `slug` that travel with the value but are not part
of it. The named metadata fields above are the current well-known fields; the
document envelope may also contain other sibling metadata fields.

Below the query layer, the storage engine, replica, and transaction APIs treat
this as an ordinary plain document root. They do not attach special operational
meaning to `value` or `source`; higher layers may add other sibling fields over
time. The current runtime-facing helpers simply provide two addressing
conventions over that same stored document:

- **Document paths** address the full stored document root.
- **Value-relative paths** address only the `document.value` subtree.

**Deletion is explicit**: removing an entity is represented only by a `Delete`
fact (section 2.2). A missing `value` field is NOT used as a tombstone in v2.
Supporting a live "undefined" cell value is deferred; if we need it later, it
should use an explicit sentinel rather than overloading deletion semantics.
There are two layers to keep separate here:

- the logical cell value `{}` is stored as the document `{ value: {} }`
- a stored document may omit `value` entirely for metadata-only cases, and even
  the degenerate stored document `{}` is still a live document, not a tombstone

Canonical examples:

| Case | Stored representation | Meaning |
| ---- | --------------------- | ------- |
| Empty object payload | `{ value: {} }` | Live cell whose payload is the empty object |
| Metadata-only document | `{ result: { "/": { "link@1": { "id": "of:abc123", "path": [] } } } }` | Live document with no payload, but with metadata |
| Empty document envelope | `{}` | Live document with no payload and no metadata set yet |
| Explicit deletion | `Delete { type: "delete", id, parent }` | Tombstone; the entity is removed from the visible head |

**Metadata links and short links**: The runtime metadata fields `pattern`,
`argument`, and `result` use the same sigil form as graph/entity links:
`{"/":{"link@1":{...}}}`. The `internal` field is different: it is raw metadata
containing a manifest array whose entries have a `partialCause` and a sigil
`link` to one derived internal cell. The older `source` property, when present,
uses the separate short-link form `{"/":"<short-id>"}` and resolves to
`of:<short-id>` in the same space. CFC metadata also uses its own compact stored
shape and is converted to a CID sigil link during traversal. When the server
executes a subscription with graph traversal, it delivers these fields as part
of the document that carries them and follows none of them; the one metadata
field traversal does follow is `cfc`, whose schema document and label
documents every delivered document is owed. The contract is in
[`05-queries.md`](05-queries.md), "Metadata / Provenance Resolution".

**Document paths**: Transaction/storage reads and writes operate on full
document paths. For example, metadata links live at top-level paths like
`["argument"]` or `["result"]`, while the cell payload root lives at `["value"]`.

**Value-relative paths**: `readValueOrThrow()` and `writeValueOrThrow()` are
thin convenience helpers that call the full-document APIs after prepending
`"value"` to the supplied path. Accessing `items[0]` on the cell value
therefore maps to the document path `["value", "items", "0"]`.

**SchemaPathSelector paths**: Query selectors stay value-relative
(e.g. `[]` for the root cell, `["items"]` for a sub-path). The shared
query/traversal layer re-roots those selectors to `["value", ...path]` before
walking the stored document.

---

## 2. Facts

A **fact** records a single state transition for an entity. Facts are immutable
once created. There are three kinds of facts, distinguished by a discriminant
field:

### 2.1 Write

A **Write** fact asserts a new value for an entity. There are two sub-kinds of
writes depending on how the value is expressed:

```typescript
// Shown at module scope.
/**
 * A Write that sets the entity's full logical document by replacement.
 */
interface SetWrite {
  type: "set";
  id: EntityId;
  value: EntityDocument; // The complete new logical document
  parent: Reference; // Hash of the previous fact, or EMPTY
}

/**
 * A Write that modifies the entity's value incrementally via patches.
 */
interface PatchWrite {
  type: "patch";
  id: EntityId;
  ops: PatchOp[]; // Ordered list of patch operations
  parent: Reference; // Hash of the previous fact, or EMPTY
}

type Write = SetWrite | PatchWrite;
```

### 2.2 Delete

A **Delete** fact tombstones an entity, removing its value. The entity can be
written to again after deletion — a delete is not permanent, it simply marks the
end of one value's lifetime.

```typescript
// Shown at module scope.
interface Delete {
  type: "delete";
  id: EntityId;
  parent: Reference; // Hash of the Write or PatchWrite being deleted
}
```

### 2.2.1 Entity Delete Semantics

A `Delete` fact changes the entity's **current binding** (its visible head on a
branch). It does **not** retroactively rewrite earlier facts, referenced blob
payloads, or any separate metadata entities that may exist beside the value.

Deletion is therefore a **reachability change**, not a metadata rewrite:

- Earlier facts remain part of history until retention/GC policy says otherwise.
- A delete of one entity MUST NOT implicitly delete or rewrite any other entity,
  including `urn:blob-meta:<hash>` entities.
- Implementations MUST NOT infer deletion from an empty object `{}` or from a
  marked document that omits `value`; only an explicit `Delete` fact removes the
  entity's current value.
- If a future extension attaches label/policy metadata directly to a surviving
  tombstone fact, that metadata should default from the deleted head's effective
  metadata unless a higher-layer API explicitly supplies replacement metadata.

This keeps delete semantics simple: remove the current value, preserve history,
and leave any future metadata rules to explicit higher-layer writes.

### 2.3 Fact (union)

```typescript
// Shown at module scope.
type Fact = Write | Delete;
```

### 2.4 Stored Fact

When a fact is committed to a space, the server assigns additional metadata:

```typescript
// Shown at module scope.
interface StoredFact {
  /** Content hash of this fact's logical content (type, id, value/ops, parent). */
  hash: Reference;

  /** The fact itself. */
  fact: Fact;

  /** Monotonic seq number (Lamport clock), assigned at commit time. Per-space. */
  seq: number;

  /** Hash of the commit that included this fact. */
  commitHash: Reference;
}
```

- `seq` is a space-global Lamport clock that increases monotonically with every
  commit. All facts in the same commit share the same seq number.
- `commitHash` links the fact to its containing transaction record.

### 2.5 Causal Chain

Every entity's facts form a **causal chain**: a singly-linked list from the
current head back to the genesis Empty state. Each fact's `parent` field
contains the hash of the immediately preceding fact for that entity.

```
Empty ← fact₁ ← fact₂ ← fact₃ (head)
```

This chain is used for conflict detection (see §03 Commit Model) and for
point-in-time reconstruction.

---

## 3. References (Content Addressing)

A **Reference** is a content hash that uniquely identifies an immutable value.
References are computed using SHA-256 over a canonical merkle-tree encoding of
the value (the same `merkle-reference` algorithm used in v1). The hash algorithm
is SHA-256 applied to the canonical merkle-reference encoding (as implemented in
the `merkle-reference` package). This produces a multihash-encoded, multibase
base32-lower string.

```typescript
/**
 * An opaque, content-addressed identifier. Encoded as a multibase
 * base32-lower string prefixed with "b" (e.g. "bafk...").
 */
type Reference = string & { readonly __brand: unique symbol };
```

### 3.1 Hash Computation

Fact hashes are computed over the **logical content** of the fact. For a
`SetWrite`, this is `{ type, id, value, parent }`. For a `PatchWrite`, this is
`{ type, id, ops, parent }`. For a `Delete`, this is `{ type, id, parent }`.

The hash function produces a merkle reference by recursively building a tree
from the JSON value, then hashing the root. Primitive values are leaf nodes;
objects and arrays are interior nodes whose children are hashed first.

### 3.2 The Empty Reference

The **Empty** reference represents the genesis state before any writes. It is
computed as the merkle reference of the entity's identity:

```typescript
// Shown inside a pattern body.
const EMPTY = refer({ id: entityId });
```

When a fact's `parent` equals the Empty reference for that entity, it is the
first fact in the entity's causal chain.

In the database, the first fact in an entity's causal chain stores `NULL` in its
`parent` column. The Empty reference is a TypeScript-level concept used by
client code and the commit model. The storage layer maps between the two: `NULL`
in SQL corresponds to the Empty reference in TypeScript.

### 3.3 Reference Serialization

References are serialized as multibase base32-lower strings (prefix `b`). In
JSON contexts, they appear as plain strings. In the database, they are stored as
`TEXT`.

References appear in three formats depending on context:

| Context                                   | Format                     | Example                                     |
| ----------------------------------------- | -------------------------- | ------------------------------------------- |
| In-memory (TypeScript)                    | Branded `Reference` object | `refer({ type: "set", id, value, parent })` |
| Database / plain string                   | Raw hash string            | `"baedreig..."`                             |
| JSON wire protocol (standalone reference) | CID link object            | `{ "/": "baedreig..." }`                    |

Do not conflate standalone `Reference` serialization with entity-link
serialization. Graph/entity links use the sigil form
`{"/":{"link@1":{"id":"of:...","path":[],"space":"did:key:..."}}}`, while
`EntityDocument.source` uses the short-link form `{"/":"<short-id>"}`.

---

## 4. Content-Addressed Blobs

A **blob** is immutable, write-once binary data identified by its content hash.
Blobs are separate from entities — they never change after creation. They are
used for storing images, files, compiled artifacts, or any data that is
referenced by entities but should not be duplicated or versioned the same way.

Current-pass scope: the rewrite only needs immutable content-addressed blob
storage and reference plumbing so runner-facing entity history can point at
large payloads without inlining them. Richer blob delivery, authenticated
download/upload APIs, URL issuance, and product-facing policy are deferred to a
later layer and are not part of the MVP acceptance bar for the core
seq/revision rewrite.

```typescript
// Shown at module scope.
interface Blob {
  /** Content hash = identity. SHA-256 of the raw bytes. */
  hash: Reference;

  /** Immutable payload bytes. The hash is computed from this value. */
  value: Uint8Array;

  /** MIME type, e.g. "image/png", "application/wasm". */
  contentType: string;

  /** Size in bytes (redundant with data.length, stored for indexing). */
  size: number;
}
```

Key properties:

- **Immutable payload**: Once a blob payload is stored, it never changes. Its
  hash is computed from the payload bytes — if the bytes change, it's a
  different blob.
- **Deduplicated**: Two identical payloads produce the same hash and are stored
  once.
- **No history on the payload itself**: Blob bytes have no causal chain, no
  version numbers, and no patches.
- **Mutable metadata lives separately**: Descriptions, provenance,
  application-specific policy, and similar fields are regular entity state keyed
  off the blob hash (section 5). This keeps blobs close to regular data:
  immutable content-addressed value, mutable metadata beside it.
- **Separate table**: Blob payloads live in their own storage table
  (`blob_store`), distinct from entity facts. See §02 Storage for the schema.

### 4.1 Referencing Blobs from Entities

Entity values can reference blobs by including the blob's hash as a field value.
The convention is:

```typescript
// Shown for illustration only.
// An entity value that references a blob
{
  "$blob": "bafk...",   // Reference to the blob's content hash
  "filename": "photo.jpg",
  "alt": "A photo"
}
```

The `$blob` field is a convention, not enforced by the storage layer. Schemas
can validate that blob references resolve to actual blobs.

---

## 5. Blob Metadata

Blobs themselves are immutable, but metadata about blobs (descriptions,
provenance, application-specific policy) is mutable. Blob metadata is stored as
a **regular entity** whose `id` is derived from the blob's content hash.

```typescript
// Shown inside a pattern body.
/**
 * Derives the entity ID used to store metadata for a given blob.
 */
function blobMetadataId(blobHash: Reference): EntityId {
  return `urn:blob-meta:${blobHash}`;
}
```

The metadata entity's value follows this shape:

```typescript
// Shown at module scope.
interface BlobMetadata {
  /** The blob this metadata describes. */
  blob: Reference;

  // Future: additional metadata fields (description, provenance, labels, etc.)
}
```

Because metadata is a regular entity, it benefits from all entity features:
versioning, causal chains, patches, conflict detection, point-in-time reads, and
branch isolation.

Phase 1 only requires the split between immutable blob payload and mutable blob
metadata. Label/classification semantics are deferred until the metadata model
is reintroduced.

### 5.1 Blob Payload and Metadata GC Semantics

Blob payloads and blob metadata follow different lifecycles:

- The blob payload in `blob_store` is immutable content-addressed storage.
- The blob metadata entity `urn:blob-meta:<hash>` is ordinary entity state with
  normal history, branching, and deletion semantics.

Deleting an entity that references a blob removes only **that entity binding**.
It does **not** by itself delete the blob payload or rewrite blob metadata.

More precisely:

- Deleting one reference to a blob MUST NOT implicitly delete or rewrite label /
  policy metadata for the blob or for any other reference to the same blob.
- If the blob payload remains reachable through any surviving entity or metadata
  record, it remains stored.
- If the blob payload and its associated metadata records both become
  unreachable, later garbage collection MAY reclaim them.
- Garbage collection removes unreachable storage; it does not reinterpret,
  weaken, or partially merge metadata.

In other words, deleting a name or entity that points at content is a
reachability update. The payload and any separate metadata survive until they
become unreachable and GC reclaims them.

---

## 6. Incremental Operations (Patches)

Memory v2 supports two mutation modes for entity values:

### 6.1 Set (Full Replacement)

A `set` operation replaces the entity's entire value. The new value IS the
complete state. This is semantically identical to v1 assertions.

### 6.2 Patch (Incremental Change)

A `patch` operation applies a list of fine-grained operations to the entity's
current value. Patch operations are inspired by
[JSON Patch (RFC 6902)](https://datatracker.ietf.org/doc/html/rfc6902) but are
**not bound by it**. Key differences from RFC 6902:

- **`add` creates intermediate parents automatically.** Writing to
  `/person/name` creates the `person` object if it doesn't exist. Numeric path
  segments create arrays; string segments create objects. When a schema is
  available, it guides the choice between array and object.
- **Custom `splice` operation** for efficient array manipulation.
- Collaborative editor operations are a distinct top-level `apply-op` write
  class rather than `PatchOp` extensions. The server derives an ordinary patch
  revision from each accepted non-empty batch; see
  [Collaborative Operations, Views, and Anchors](./07-op-views-and-annotations.md).

```typescript
// Shown at module scope.
/**
 * A JSON Pointer path, e.g. "/foo/bar/0".
 */
type JSONPointer = string;

/**
 * Patch operations (inspired by RFC 6902, not bound by it).
 */
interface ReplaceOp {
  op: "replace";
  path: JSONPointer;
  value: FabricValue;
}

interface AddOp {
  op: "add";
  path: JSONPointer;
  value: FabricValue;
  // Creates intermediate parents automatically:
  // numeric path segments → array, string segments → object,
  // schema-guided when available.
}

interface RemoveOp {
  op: "remove";
  path: JSONPointer;
}

interface MoveOp {
  op: "move";
  from: JSONPointer;
  path: JSONPointer;
}

/**
 * Array splice: more efficient than individual add/remove ops.
 */
interface SpliceOp {
  op: "splice";
  path: JSONPointer; // Path to the target array
  index: number; // Start index
  remove: number; // Number of elements to remove
  add: FabricValue[]; // Elements to insert at the index
}

type PatchOp = ReplaceOp | AddOp | RemoveOp | MoveOp | SpliceOp;
```

### 6.3 Patch Classes

Not all patches have the same concurrency behavior:

- **Position-independent patches** target stable keys and overwrite content
  without depending on collection ordering. Example: replacing `/profile/name`.
  These are the best candidates for future read-free fast paths.
- **State-dependent patches** depend on the current shape or ordering of the
  document. `remove`, `move`, and `splice` are in this class, and `add` can be
  as well when it targets positional array locations. These should continue to
  carry read dependencies until we introduce stronger semantics (for example,
  match-based removal or CRDT/OT operations).

### 6.4 Patch Application Semantics

Patches are applied **in order**, left to right. Each operation in the list
transforms the state produced by the previous operation. If any operation in the
patch list is invalid (e.g., removing a non-existent path), the entire patch
fails and the fact is rejected.

```typescript
// Shown inside a pattern body.
function applyPatch(state: FabricValue, ops: PatchOp[]): FabricValue {
  let current = state;
  for (const op of ops) {
    current = applyOp(current, op);
  }
  return current;
}
```

### 6.5 Patch Composition

Multiple sequential patches can be **composed** into a single equivalent patch
for optimization, but the storage layer does not perform this automatically.
Patches are stored as-is.

When replaying patches for a read, each patch's operations are applied
sequentially to the state produced by the previous fact:

```
snapshot_v10 → apply(patch_v11) → apply(patch_v12) → ... → current_state
```

### 6.5 Patches in Facts

A `PatchWrite` fact stores its patch operations directly. The fact's content
hash covers the full patch operation list, ensuring integrity.

In the storage layer, patch operations are serialized with the shared
FabricValue boundary codec and stored inline on the seq-addressed
`revision.data` column.
See §02 Storage for details.

---

## 7. Snapshots

A **snapshot** is a materialized full value of an entity at a specific seq.
Snapshots accelerate reads by avoiding full replay of the entity's entire patch
history.

```typescript
// Shown at module scope.
interface Snapshot {
  /** The entity this snapshot is for. */
  id: EntityId;

  /** The seq (Lamport clock) at which this snapshot was taken. */
  seq: number;

  /** Reference to the full value in the value table. */
  valueRef: Reference;

  /** Branch this snapshot belongs to (see §06 Branching). */
  branch: string;
}
```

### 7.1 Snapshot Creation Policy

Snapshots are created **periodically** based on a configurable policy. The
default policy is: create a snapshot every **N patches** per entity (e.g., every
10 patches). The snapshot interval is a space-level configuration.

```typescript
interface SnapshotPolicy {
  /** Create a snapshot after this many patches since the last snapshot. */
  patchInterval: number; // Default: 10
}
```

Snapshots can also be created on-demand (e.g., for frequently-read entities or
before archiving).

### 7.2 Read Path with Snapshots

To read an entity's current value:

1. Find the most recent snapshot for the entity on the target branch.
2. Collect all `PatchWrite` facts with `seq > snapshot.seq` up to the head.
3. Start from the snapshot value and apply each patch in seq order.
4. If no snapshot exists, start from the first `SetWrite` fact and replay all
   subsequent patches.

For point-in-time reads at a specific seq:

1. Find the most recent snapshot with `seq <= targetSeq`.
2. Collect patches in `(snapshot.seq, targetSeq]`.
3. Replay from snapshot through patches.

The engine can reuse an immutable decoded revision from its bounded document
cache as a replay prefix. The cached revision must match the resolved branch and
scope instance and lie within the selected sequence and operation-index range.
Only the remaining patches are applied, retaining frozen subtrees outside their
write paths. An evicted prefix is reconstructed from stored facts. Commit-local
decoded revisions remain staged until the transaction commits and are discarded
on rollback. Cache hits include direct reads and replay-prefix reuse.

See §02 Storage for the SQL queries that implement this.

### 7.3 Snapshot Invariants

- A snapshot's value MUST equal the result of replaying all facts from genesis
  up to `snapshot.seq`.
- Snapshots are **redundant** — they can always be recomputed from the fact
  history. Deleting a snapshot never loses data; it only makes reads slower.
- Snapshots are per-branch. A snapshot on branch A does not apply to branch B
  unless the seqs coincide exactly.

---

## 8. Type System

### 8.1 No Type Dimension in Storage

In v1, every fact carried a `the` field (MIME type, always `application/json`)
alongside its `of` (entity id). This created a two-dimensional key space
`(the, of)` for entity identity.

In v2, we drop the `the` dimension entirely. An entity is identified solely by
its `id`. There is no MIME type stored per fact.

**Rationale**: The `the` field was always `application/json` in practice. Type
information is better expressed in schemas, which describe the shape of entity
values without coupling storage to content types.

### 8.2 Schemas

Schemas define the expected structure of entity values. They are stored as
regular entities (self-describing: a schema is an entity whose value is a JSON
Schema).

```typescript
// Shown at module scope.
// A schema entity's value is a JSON Schema
interface SchemaEntity {
  $schema: "https://json-schema.org/draft/2020-12/schema";
  type: "object";
  properties: Record<string, JSONSchema>;
  // ... standard JSON Schema fields
}
```

Schemas are used for:

- **Validation**: Ensuring that writes conform to expected shapes.
- **Traversal**: Following links between entities (pointer fields that reference
  other entities by id).
- **Query optimization**: Schema-aware queries can pre-fetch linked entities.

Schema-based traversal is covered in §05 Queries.

### 8.3 Entity-Schema Binding

The binding between an entity and its schema is **not** stored in the fact
table. Instead, it is established by convention or by a schema registry (a
well-known entity that maps entity id patterns to schema entity ids).

This decoupling means:

- The storage layer is schema-agnostic. It stores JSON values without
  validation.
- Validation is performed by higher layers (the runtime, the client).
- An entity's schema can evolve independently of its data.

---

## 9. System Entities

In v1, system metadata (ACLs, labels, schemas) was distinguished from regular
data using the `the` dimension. In v2, there is no `the` dimension — system
metadata is stored as **regular entities** with well-known ID conventions.

### 9.1 Well-Known Entity ID Patterns

| Pattern                | Purpose                             | Example                 |
| ---------------------- | ----------------------------------- | ----------------------- |
| `<space-did>`          | Access control list for a space     | `did:key:z6Mkk...`      |
| `urn:schema:<name>`    | Schema definition                   | `urn:schema:todo-item`  |
| `urn:blob-meta:<hash>` | Mutable metadata for a blob payload | `urn:blob-meta:bafk...` |

### 9.2 Design Rationale

System entities are normal entities. They benefit from all entity features:
versioning, causal chains, patches, conflict detection, point-in-time reads, and
branch isolation. There is no special storage path or query path for system
entities — the well-known ID convention is sufficient to distinguish them.

This approach replaces v1's `the` dimension with a simpler, more uniform model:
instead of a two-dimensional key space `(the, of)`, every entity is identified
by a single `id` whose URI scheme communicates its purpose.

---

## 10. Common Types

The following type definitions are used throughout the specification:

```typescript
/** Branch identifier string. */
type BranchId = string;

/** Human-readable branch name ('' for the default branch). */
type BranchName = string;

/** A decentralized identifier for a space. */
type SpaceId = `did:${string}`;

/** A decentralized identifier (generic). */
type DID = `did:${string}`;

/** Any valid JSON value. */
type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONValue[]
  | { [key: string]: JSONValue };

/**
 * Any runtime value accepted by the shared memory-v2 boundary codec.
 * This strictly contains JSONValue and additionally supports extra leaves
 * such as bigint/undefined plus escaped slash-key objects.
 */
type FabricValue = unknown;

/** A JSON Schema definition. */
type JSONSchema =
  | boolean
  | {
    type?: string;
    properties?: Record<string, JSONSchema>;
    items?: JSONSchema;
    [key: string]: unknown;
  };
```
