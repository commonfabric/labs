# 5. Queries

This section defines how clients retrieve data from a Space. The query system
supports simple pattern matching, schema-driven graph traversal, point-in-time
reads, session watch sets, and branch-aware retrieval.

## Status Note

The current implementation only exposes the schema-guided `graph.query` shape on
the v2 wire:

- one-shot reads use `roots: [{ id, selector }]` plus `branch` and `atSeq`
- watch specs also reuse that graph-shaped query payload in the current pass
- the older simple `query` / wildcard selector surface remains documented design
  but is not yet shipped on the wire
- steady-state watch refresh does not yet guarantee automatic `removes` when a
  topology shrink makes previously reachable entities irrelevant
- selector paths remain value-relative; the storage/transaction layer still uses
  full document paths

## 5.1 Query Types

There are two query types, each with increasing expressiveness:

1. **Simple queries** -- match entities by id.
2. **Schema queries** -- follow references between entities guided by a JSON
   Schema, reusing the traversal patterns from `traverse.ts`.

Both query types can participate in a session watch set. One-shot queries are
the direct request/response mode.

```typescript
// Shown at module scope.
// Base query options shared by all query types
interface QueryOptions {
  branch?: BranchName; // Target branch (default branch if omitted)
  atSeq?: number; // Point-in-time read (latest if omitted)
}
```

---

## 5.2 Simple Queries

A simple query matches entities by id. This is the lightweight path for clients
that know exactly which entities they need.

### 5.2.1 Query Structure

```typescript
// Shown at module scope.
interface Query extends QueryOptions {
  // Match patterns, keyed by entity id.
  // Use "*" as the id to match all entities.
  select: Record<EntityId | "*", EntityMatch>;
}

interface EntityMatch {
  // Empty object means "match any version."
  // If omitted entirely, treated as empty object.
  [key: string]: unknown;
}
```

**Matching rules:**

| `select` key                             | Behavior                        |
| ---------------------------------------- | ------------------------------- |
| Specific id (e.g. `"urn:entity:abc123"`) | Match exactly that entity       |
| `"*"` (wildcard)                         | Match all entities in the space |

When using the wildcard `"*"` selector, the server MAY impose a fan-out limit
(e.g., 10,000 entities) to prevent excessive memory use. If the limit is
exceeded, the server returns a paginated result (see section 5.8) rather than an
error.

### 5.2.2 Simple Query Execution

Given a `Query`, the server:

1. Identifies the target branch (default if unspecified).
2. For each pattern in `select`:
   - If the key is `"*"`, iterate all entities on the branch.
   - If the key is a specific id, look up that entity's head on the branch.
3. For each matched entity, read its current head state.
4. If `atSeq` is provided, reconstruct the entity state at that seq (see section
   5.5).
5. Assemble and return a `FactSet`.

---

## 5.3 Schema Queries

Schema queries extend simple queries with JSON Schema-driven graph traversal.
Starting from a set of root entities, the server follows references embedded in
entity values, guided by a schema that constrains which paths to explore and
which linked entities to include.

The traversal code in `packages/runner/src/traverse.ts` is **shared between
client and server**. The client reaches `SchemaObjectTraverser` through
`schema.ts` for validation and transformation; the server reaches the same
traverser through `@commonfabric/runner/graph-query`, which drives it over
documents the storage engine supplies. That gives identical traversal behavior
on both sides, and the implementation MUST preserve this shared-code property.
[Schema graph queries](../../features/schema-graph-queries.md) describes what
the two packages exchange to do that.

### 5.3.1 Schema Query Structure

```typescript
// Shown at module scope.
interface SchemaQuery extends QueryOptions {
  selectSchema: SchemaSelector;
  limits?: SchemaQueryLimits;
}

interface SchemaQueryLimits {
  maxDepth?: number; // Maximum traversal depth (default: 10)
  maxEntities?: number; // Maximum entities to visit (default: 1000)
}

// SchemaSelector maps entity ids to schema path selectors.
// The path+schema pair applies directly per entity.
type SchemaSelector = Record<EntityId | "*", SchemaPathSelector>;

// A path + schema pair that describes what to traverse
// within a matched entity's value.
interface SchemaPathSelector {
  path: string[]; // Value-relative path segments into document.value
  schema?: JSONSchema; // JSON Schema constraining traversal
}
```

The `path` field navigates into the entity's value before applying the schema.
For example, `{ path: ["settings", "theme"], schema: { type: "object" } }` would
navigate to the `settings.theme` sub-object and traverse it as an object.

This is intentionally different from transaction/storage path handling. Query
selectors are value-relative, while lower layers operate on full document paths
such as `["value", "settings", "theme"]` or `["source"]`.

### 5.3.2 Schema Traversal Algorithm

Schema traversal follows the patterns established in `traverse.ts`, adapted for
the Memory v2 data model. The algorithm has three key components: path
following, schema-guided filtering, and reference resolution.

#### Path Following

Starting from a matched entity's value, the traverser walks the `path` segments
from the `SchemaPathSelector`:

1. At each step, descend into the current value using the next path segment.
2. If the current value is a reference (link to another entity), resolve it
   before continuing.
3. Once all path segments are consumed, begin schema-guided traversal on the
   resulting value.

This mirrors the `getAtPath` function from `traverse.ts`, which walks a document
path while resolving references encountered along the way.

#### Schema-Guided Filtering

Once at the target path, the traverser applies the JSON Schema to determine
which parts of the value to include and which references to follow:

```
function traverseWithSchema(value, schema):
  if schema is true or {}:
    // Accept everything -- traverse the full DAG
    return traverseDAG(value)

  if schema is false:
    // Reject -- skip this subtree
    return undefined

  if schema.type == "object":
    result = {}
    for each property in value:
      propSchema = schemaAtPath(schema, [property])
      if propSchema is not false:
        result[property] = traverseWithSchema(value[property], propSchema)
      else:
        // Property not in schema -- include raw value without following refs
        result[property] = value[property]
    // Apply defaults for missing required properties
    return result

  if schema.type == "array":
    result = []
    for each item in value:
      itemSchema = schema.items
      result.push(traverseWithSchema(item, itemSchema))
    return result

  if schema.anyOf:
    // Try each option, merge matches (object property union)
    matches = []
    for each option in schema.anyOf:
      match = traverseWithSchema(value, merge(schema, option))
      if match != undefined:
        matches.push(match)
    return mergeAnyOfMatches(matches)

  if schema.allOf and schema.allOf is not empty:
    // An empty allOf constrains nothing and is passed over; the keywords
    // beside it decide the node below.
    // All must match, and their results merge the same way
    matches = []
    for each option in schema.allOf:
      match = traverseWithSchema(value, merge(schema, option))
      if match == undefined:
        return undefined  // mismatch
      matches.push(match)
    return mergeAnyOfMatches(matches)

  // Primitive types: validate and return
  if typeMatches(value, schema.type):
    return value
  return undefined
```

This mirrors the `SchemaObjectTraverser.traverseWithSchema` method from
`traverse.ts`. `merge(schema, option)` there is shallow, and
`mergeAnyOfMatches` unions the properties of the surviving branches; both are
specified under
[Logical schema operators](../space-model/8-traversal.md#logical-schema-operators).

#### Reference Resolution

When the traverser encounters a reference (a value that points to another
entity), it:

1. **Parses the reference** to extract the target entity id and sub-path.
2. **Checks the cycle tracker** to prevent infinite loops when following
   circular references.
3. **Loads the target entity** from the store.
4. **Narrows the schema** for the target entity. The schema from the referencing
   context is combined with any schema embedded in the reference itself using
   schema intersection (see 5.3.3).
5. **Continues traversal** on the target entity's value with the narrowed
   schema.

This mirrors the `followPointer` function from `traverse.ts`.

#### Metadata / Provenance Resolution

A document carries runtime metadata beside its `value`: the `pattern`,
`argument`, and `result` metadata links, the `internal` manifest, and the
`cfc` label envelope. Traversal delivers that metadata as part of the
document it sits on, and follows exactly one of those fields: `cfc`.

A stored document's top-level object holds metadata links and manifest
links such as:

```json
{
  "pattern": { "/": { "link@1": { "id": "of:pattern-abc", "path": [] } } },
  "argument": { "/": { "link@1": { "id": "of:argument-def", "path": [] } } },
  "internal": [
    {
      "partialCause": "counter",
      "link": { "/": { "link@1": { "id": "of:internal-ghi", "path": [] } } }
    }
  ],
  "result": { "/": { "link@1": { "id": "of:result-jkl", "path": [] } } }
}
```

The `pattern`, `argument`, and `result` fields use the same sigil link form as
ordinary cell references. The `internal` field is raw metadata, not a direct
metadata link. It stores a manifest array, and each manifest-entry `link` names
an internal cell owned by the result cell. The `cfc` metadata field is also
special: it uses a compact metadata object, and traversal converts its
`schemaHash` into a CID sigil link before loading the referenced document, and
does the same for every label document a version-2 envelope's entries
reference by `{ "$ref": "cid:…" }`
([content-addressed-cfc-labels.md](../content-addressed-cfc-labels.md)). Each
synthesized link MUST declare
[space scope](../content-addressed-schemas.md#schema-documents) even when the
document carrying the metadata is user- or session-scoped: content-addressed
documents never inherit a referrer's scope.

What the evaluation loads of that metadata is the same for every document it
delivers, whether a query NAMED the document as a root or the walk reached it
through a link crossing:

- The schema document its `cfc` envelope names. A reader of a labeled
  document checks what it may read against that schema, so the server MUST
  resolve the envelope's hash to a CID document, load it, add it to the query
  result and the watch tracker, and track an absent one so that it is
  delivered when it is written.

- The label documents its `cfc` envelope references, one per distinct
  reference. A reader resolves the envelope's labels from them synchronously,
  so the server MUST load, deliver, and track each of them exactly as it does
  the schema document.

- Nothing else. The server MUST NOT load, deliver, or track the target of a
  `pattern`, `argument`, or `result` link, or the cells an `internal`
  manifest lists, on the strength of the link alone. Those links are data a
  consumer reads off the delivered document; a consumer that wants a target
  names it with a query of its own. A runtime that instantiates a piece it
  did not set up names the argument document and each cell the pattern's
  descriptors derive before it reads them, the way its dependency pre-sync
  does for a resume.

This is part of the query result shape: what a query delivers depends on
what its selectors reach and on the labels of what they reach, and on
nothing else, so a subscription's delivered shape does not depend on the
order in which documents changed or on which query first reached a
document. Coverage follows the same rule: a later query naming a document
an earlier evaluation reached is covered by existing watch state when the
tracker already covers its selector.

Content-addressed schema documents ride the same mechanism
(`docs/specs/content-addressed-schemas.md`): a link or selector schema
holding an external `{ "$ref": "cid:…" }` reference makes traversal load the
referenced schema document — and, transitively, the documents behind its own
external refs — into the query result and watch tracker, registering each
after hash verification (`loadExternalSchemaDocs()` in `traverse.ts`). A
document whose content does not hash to its id is tracked but never
registered, and refs to it stay unresolved.

### 5.3.3 Cycle Detection

Graph traversal must handle cycles. Three cycle detection mechanisms are used,
all derived from `traverse.ts`:

#### CycleTracker

Tracks visited nodes by identity. If a node is visited twice during the same
traversal path, the second visit returns `null` (cycle detected, do not
descend).

```typescript
// Shown for illustration only.
class CycleTracker<K> {
  private visiting: Set<K>;

  // Returns a disposable scope if not a cycle, or null if cycle detected.
  // On dispose, removes the key so parallel branches can visit the same node.
  include(key: K): Disposable | null;
}
```

#### CompoundCycleTracker

A more nuanced tracker that considers both node identity and schema context. The
same entity can be visited multiple times with different schemas without
triggering a false cycle. This is important because a single entity may be
reachable via different schema paths that expose different subsets of its data.

```typescript
// Shown for illustration only.
class CompoundCycleTracker<IdentityKey, SchemaKey, Value> {
  // Returns null if this (identityKey, schemaKey) pair has been visited.
  // Uses identity equality for identityKey, deep equality for schemaKey.
  include(
    identityKey: IdentityKey,
    schemaKey: SchemaKey,
    value?: Value,
  ): Disposable | null;

  // After a failed include, retrieve the value registered by the first visit.
  getExisting(
    identityKey: IdentityKey,
    schemaKey: SchemaKey,
  ): Value | undefined;
}
```

In practice, the traverser uses a `CompoundCycleTracker` parameterized as:

```typescript
// Shown at module scope.
type PointerCycleTracker = CompoundCycleTracker<
  JSONValue, // The reference value (identity comparison)
  JSONSchema, // The schema context (deep equality comparison)
  any // The traversal result for this node
>;
```

#### Branches returning to their own position

A combinator branch evaluates the same value at the same address as the schema
it belongs to, so neither tracker sees it come back. A union whose handle
branch names the union itself (`type Recursive = Cell<Recursive> | null`)
returns to its own traversal without descending. The traverser keeps the memo
keys of the traversals in progress at the current position, and a branch that
reaches one of them stands for that traversal's result, which the traversal
that began the position reaches as a fixed point in rounds. The first round
takes the branch as no match. Each later round takes the result the traversal
it comes back to had in the latest round that reached it, and a traversal
reached again within a round takes its result from earlier in the round, so a
round traverses each schema at the position once. Rounds repeat until one
leaves no traversal a branch came back to matching where what stood in for it
did not. The result then matches as the schema unrolled does and selects the
properties it selects; where matching branches project one property
differently, the round's merges decide which projection is kept, since an
unrolling need not settle on one. A `oneOf`, which can reject in one round what
it accepted in the round before, keeps the round before that rejection. A result
that took something standing in for a traversal holds only for its round, so it
is returned but not memoized.

### 5.3.4 Schema Narrowing

When following a reference from entity A to entity B, the schema applicable to
B is decided by precedence, not by intersection. The schema context from A's
traversal (what A expects B to look like) governs whenever it says anything at
all; the schema embedded in the reference itself (what the reference declares
B to contain) fills in only where the traversal is agnostic.

`combineSchemaForLink` implements the rule, gated by the
`readerSchemaPrecedence` experimental flag (default on; off restores the
strict pseudo-intersection at reference crossings — see
`docs/development/EXPERIMENTAL_OPTIONS.md`).
[`link-schema-precedence.md`](../link-schema-precedence.md) is the
consolidated specification of the rule, the `default` exception, and the
flow-control crossing seam. A reference routinely describes
more of its target than the traversal asked for, and none of that description
— extra properties, extra `required` entries, a different shape — reaches the
combined schema:

- A `false` traversal schema stays `false`: the traversal selected nothing,
  and the reference cannot widen that.
- A true or empty traversal schema (`true`, `{}`, or a flag-only wrapper such
  as `{asCell: [...]}`) adopts the reference's schema, keeping its own
  `asCell` wrapper. This is what types a schemaless read by the references it
  crosses, and what lets a reference's `false` schema attenuate an open read
  to nothing.
- Any other traversal schema is used as it stands and the reference's schema
  is ignored — a `false` reference schema blocks only traversals that brought
  no shape of their own.

`default` is the one keyword that crosses the precedence line: a value's
default is inherited from the last crossed schema that declares one. Each
hop's stored schema describes that hop's target, so the nearest declaration
wins — a reference's top-level `default` overrides earlier references' and
the traversal's own, and where no reference declares one the traversal's
stands.

A discarded reference schema's `ifc` does not ride onto the result: flow
control never travels through combined schemas. A transaction is instead
marked cfc-relevant at each crossing whose stored schema declares `ifc`,
independently of which side won the combination, and enforcement reads
stored cfc metadata and label views rather than combined schemas.
[`link-schema-precedence.md`](../link-schema-precedence.md) specifies that
crossing seam: the marking sites, the `cid:` closure registry warming, and
the broken-declaration rule.

The sibling `combineSchema` is the strict best-effort pseudo-intersection,
used to merge a compound schema's base keywords with its own `anyOf`/`oneOf`
branches, where both parts were authored as one constraint. Object schemas
combine shared properties recursively, retain properties allowed by only one
side, and preserve every property required by either input. False schemas and
disjoint types produce a false schema, while an unconstrained schema yields to
the other input, and integer is treated as a subtype of number. Array schemas
combine their `items` schemas recursively; their positional `prefixItems`
extend to the longer input prefix, each position combining the two positional
schemas and falling back to that input's `items` schema after its prefix ends,
with `prefixItems` omitted when the merged prefix is empty.

Neither operation is a complete JSON Schema intersection, and neither resolves
`$ref` values. See `combineSchemaForLink`, `combineSchema`, and `narrowSchema`
in `packages/runner/src/traverse.ts` for the implementation.

### 5.3.5 Schema Tracker

During traversal, the server records which entities were visited and with what
schema context. This information is stored in a `SchemaTracker` (a `MapSet`
mapping entity keys to `SchemaPathSelector` sets):

```typescript
// Shown at module scope.
type SchemaTracker = MapSet<
  string, // Key: "{space}/{entityId}"
  SchemaPathSelector // The schema+path used when visiting this entity
>;
```

The schema tracker serves two purposes:

1. **Watch bookkeeping** -- after the initial query, the server knows exactly
   which entities are reachable from the query roots. When any of these entities
   change, the affected session watch union can be recomputed.
2. **Incremental update evaluation** -- when an entity changes, the server
   re-evaluates its links using the stored schema to determine whether new
   entities have become reachable (or old ones unreachable).

### 5.3.6 Schema Query Execution

Given a `SchemaQuery`, the server:

1. Identifies the target branch.
2. Iterates the `selectSchema` patterns to find root entities (same matching
   rules as simple queries).
3. For each root entity: a. Loads the entity's current value. b. Runs the schema
   traversal algorithm (5.3.2), which recursively loads and filters linked
   entities. c. For every loaded document, loads the schema document its `cfc`
   metadata names (5.3.2 Metadata / Provenance Resolution). d. Records all
   visited entities in the schema tracker.
4. Collects all visited entities and their values into the result `FactSet`.
5. Returns the `FactSet` along with the schema tracker (for watch setup).

The initial execution and every later schema-watch refresh MUST use the same
traversal semantics as `packages/runner/src/traverse.ts`. The server MAY cache
bookkeeping such as reachable-entity sets or dirty roots, but the result sent to
clients must be equivalent to rerunning `graph.query` with the shared traversal
code against the current committed state.

---

## 5.4 Session Watch Sets and Catch-Up Sync

Live query behavior is modeled as a session watch set rather than as a
collection of independent subscription streams.

### 5.4.1 Watch Lifecycle

```text
Client                                Server
  |                                     |
  |--- watchSet([queryA, queryB]) ---->|
  |                                     |-- evaluate watch union
  |<--- ok(serverSeq) -----------------|
  |<--- session/effect(sync) ----------|
  |                                     |
  |--- watchAdd([queryC]) ------------->|
  |                                     |-- evaluate only new roots
  |                                     |-- stop at tracked doc+selector hits
  |<--- ok(serverSeq) -----------------|
  |<--- session/effect(sync upserts) --|
  |                                     |
  |     (data changes on server)        |
  |<--- session/effect(sync) ----------|
  |                                     |
  |--- watchSet([queryA]) ------------>|
  |<--- ok(serverSeq) -----------------|
  |<--- session/effect(sync removes) --|
```

### 5.4.2 Simple Watches

For simple queries, the server:

1. Evaluates the union of all simple watch selectors on the session.
2. Tracks the relevant entities and the session's integrated `seenSeq`.
3. On each commit or watch change, computes the delta between the relevant set
   at the prior `seenSeq` and the relevant set now.
4. Sends the result as one or more `SessionSync` frames.

### 5.4.3 Schema-Aware Watches

Schema watches are more sophisticated because the relevant entity set can change
as references change.

The server manages this by maintaining a schema tracker for the session's watch
union:

1. **Watch install**: evaluate the schema query, recording every visited entity
   and the schema context used.
2. **Watch add**: for new roots, start traversal only from those roots. If the
   traversal reaches an entity-plus-selector pair that is already tracked, stop
   immediately and reuse the existing downstream result. Additive watch growth
   may also reuse a persistent traversal memo for already-seen
   document-path-plus-schema work.
3. **On commit**: for each changed entity, determine whether it can affect the
   current tracked graph.
4. **Re-evaluate affected topology**: if links or source chains changed, re-run
   the shared traversal logic only from the affected tracked entities to
   discover newly reachable or no-longer-reachable entities. This refresh path
   should use a fresh traversal memo even when the tracked frontier itself is
   persistent.
5. **Emit sync**: send entity upserts for newly relevant/current entities and
   removes for entities that fell out of the watch union.

### 5.4.4 Deduplication

The server deduplicates at the session layer:

- one entity appears once in the session cache even if multiple watches include
  it
- `seenSeq` acts as the primary watermark
- on a reconnect the client's declared `holdings` (04-protocol.md section
  4.1.2) replace the server's per-session delivery memory as the diff base:
  the server's memory of what it sent is a claim about the client the client
  itself can contradict, and a held-at-seq statement from the replica is the
  exact vocabulary the diff compares
- optional `sentEntities` bookkeeping MAY still be used for watch-local
  optimizations like `excludeSent`

### 5.4.5 Update Coalescing

When multiple commits occur in rapid succession, the server MAY coalesce live
sync into one `SessionSync` frame covering the latest relevant state rather than
sending one frame per commit.

The required ordering invariant is:

1. Drain currently pending successful commits for the relevant space/branch.
2. Recompute the affected watch unions against that latest state.
3. Emit sync only after the recomputation is complete.

Transact verdicts return inline without waiting for such a refresh; the
verdict's catch-up obligation guarantees the next frame to the committing
session carries `caughtUpLocalSeq` covering it, and the CLIENT parks the
verdict's state application until that marker (04-protocol.md section
4.11.2, CT-1927).

### 5.4.6 Session Watch State

```typescript
// Shown at module scope.
interface WatchState {
  id: string;
  query: Query | SchemaQuery;
  branch: BranchName;
}

interface SessionWatchState {
  sessionId: string;
  seenSeq: number;
  watches: WatchState[];
  schemaTracker?: SchemaTracker;
  sentEntities?: Set<string>;
}
```

---

## 5.5 Point-in-Time Queries

A point-in-time query reconstructs the state of entities at a specific seq on a
specific branch. This is specified via the `atSeq` field in `QueryOptions`.

### 5.5.1 Reconstruction Algorithm

For each matched entity at `atSeq`:

1. **Find the nearest snapshot** at or before the target seq. A snapshot is a
   stored full-value checkpoint of the entity at a specific seq.
2. **Collect patches** between the snapshot seq and the target seq. These are
   the incremental operations (patch operations) stored as facts with seq in the
   range `(snapshotSeq, targetSeq]`.
3. **Replay patches** on the snapshot value in seq order to reconstruct the
   entity's state at the target seq.
4. If the entity was deleted (a `Delete` fact) at or before the target seq,
   return the tombstone state.

```
state(entity, targetSeq):
  snapshot = findLatestSnapshot(entity, branch, targetSeq)
  patches = findPatches(entity, branch, snapshot.seq, targetSeq)

  value = snapshot.value
  for each patch in patches (ordered by seq ascending):
    if patch is Delete:
      return DeletedState
    value = applyPatch(value, patch.operations)
  return value
```

### 5.5.2 Efficiency Considerations

- **Snapshot frequency**: the server periodically creates snapshots to bound the
  number of patches that must be replayed. A reasonable default is one snapshot
  every N seqs per entity (e.g. N=100).
- **No snapshot available**: if no snapshot exists for an entity, reconstruction
  starts from the entity's first `Write` fact (which is always a full value,
  acting as an implicit snapshot).
- **Seq 0**: querying at seq 0 returns the initial state (typically empty for
  all entities).

### 5.5.3 Point-in-Time with Schema Queries

Point-in-time reads compose with schema queries. The schema traversal operates
on the reconstructed values, following references to other entities that are
themselves reconstructed at the same target seq. This provides a consistent
snapshot of the entire reachable graph at a single point in time.

---

## 5.6 Classification and Redaction (Deferred)

Phase 1 of Memory v2 does **not** implement label-based query redaction.
Authorization is enforced only by space-level ACLs (see `04-protocol.md`).

Classification labels and redacted query delivery will return in a later
revision once the label/metadata model is redesigned. Until then:

- The v2 query semantics do not depend on classification claims.
- Existing compatibility fields at the cutover boundary may still accept a
  classification parameter, but phase-1 v2 ignores it.
- Subscription payloads are not partially redacted.
- There is no special label entity type in the phase-1 protocol surface.

---

## 5.7 Result Format

All queries return results as a `FactSet` -- a structured collection of current
entity states organized by entity.

### 5.7.1 FactSet Structure

```typescript
// Shown for illustration only.
// The top-level result: space -> entity states
interface QueryResult {
  [spaceId: string]: FactSet;
}

// Current entity states organized by entity id
interface FactSet {
  [entityId: EntityId]: FactEntry;
}

// A single entity entry in the result
interface FactEntry {
  value?: JSONValue; // The entity value (absent for deletes/tombstones)
  seq: number; // The seq when this fact was committed
}
```

### 5.7.2 Result Semantics

- **Present entity**: has a `FactEntry` with `value` populated.
- **Deleted entity**: has a `FactEntry` without `value` (tombstone).
- **Unknown entity**: no entry in the `FactSet` at all.

---

## 5.8 Pagination

For queries that match large numbers of entities, the server supports
cursor-based pagination.

### 5.8.1 Pagination Parameters

```typescript
// Shown at module scope.
interface PaginatedQuery extends Query {
  limit?: number; // Maximum entities to return (default: server-chosen)
  cursor?: string; // Opaque continuation token from a previous response
}
```

### 5.8.2 Pagination Response

```typescript
// Shown at module scope.
interface PaginatedResult {
  facts: FactSet;
  cursor?: string; // Present if more results are available
  hasMore: boolean; // Explicit flag for client convenience
}
```

### 5.8.3 Pagination Semantics

- The cursor is opaque to the client. The server may encode the last entity id
  and seq, or any other state needed to resume iteration.
- Pagination is **seq-consistent**: the server pins the query to the seq at
  which the first page was served, so subsequent pages reflect the same
  snapshot.
- Schema queries paginate over root entities. Linked entities reachable from a
  root are always included in the same page as that root.

---

## 5.9 Branch-Aware Queries

All queries operate on a specific branch. If no branch is specified, the default
branch is used.

### 5.9.1 Branch Resolution

```typescript
// Shown at module scope.
interface QueryOptions {
  branch?: BranchName; // Omit for default branch
  atSeq?: number; // Point-in-time read (latest if omitted)
}
```

The server resolves the branch name to a branch record (see `06-branching.md`),
then reads entity heads from that branch's head table. All entity state lookups
use the branch-scoped heads.

### 5.9.2 Cross-Branch Queries

The query system does not support querying across multiple branches in a single
request. To compare entities between branches, the client must issue separate
queries targeting each branch.

### 5.9.3 Branch + Point-in-Time

Branch and seq interact naturally: `{ branch: "feature-x", atSeq: 42 }` reads
the state of the `feature-x` branch as it was at seq 42. The reconstruction
algorithm (5.5) scopes its fact lookup to the specified branch.

---

## 5.10 Entity References and Links

Entity values may contain references (links) to other entities. This section
defines the reference formats used in the query and traversal system.

### 5.10.1 Link Format

Entity graph links use the sigil link format (v1-compatible):

```typescript
// Shown at module scope.
interface EntityLink {
  "/": {
    "link@1": {
      id?: `of:${string}`;
      path?: string[];
      space?: SpaceId;
      schema?: JSONSchema;
      overwrite?: "redirect";
    };
  };
}
```

Example:

```json
{
  "author": {
    "/": {
      "link@1": {
        "id": "of:fid1:abc123",
        "path": []
      }
    }
  },
  "title": "My Document"
}
```

`EntityDocument.source`, where older documents still use it, has a separate
short-link format:

```json
{ "source": { "/": "bafy...shortId" } }
```

This is not the form used by current piece metadata fields such as `pattern`,
`argument`, `internal`, and `result`; those fields use sigil links, and
traversal follows `cfc` alone (5.3.2 Metadata / Provenance Resolution).

### 5.10.2 Link Resolution

Given a sigil link, the traverser:

1. Parses `{"/":{"link@1":...}}` into a normalized link (id/path/space).
2. Resolves relative fields against the current traversal base.
3. Loads the target entity by normalized `id` (not by revision identity).
4. Applies `path` on the target and continues traversal with narrowed schema
   context (see 5.3.4 Schema Narrowing).

The top-level metadata fields described in 5.3.2 are delivered as data on
the document that carries them, and only `cfc` is followed. Source short-links
are a separate compatibility shape and should not be used as the example format
for piece metadata ownership links.

### 5.10.3 Entity ID References

Values can also reference entities by ID directly as a string field. The schema
determines which fields are entity ID references versus plain strings. Schema
properties marked with `$ref` or with a custom `x-entity-reference: true`
annotation indicate fields that should be followed as links during traversal.

```json
{
  "type": "object",
  "properties": {
    "owner": {
      "type": "string",
      "x-entity-reference": true
    }
  }
}
```

The traversal algorithm in section 5.3.2 supports both sigil links and
schema-annotated entity-id strings.

---

## 5.11 Reactivity Boundaries

When schema traversal encounters a reference and resolves it to another entity,
the resolved entity becomes a separate **reactive unit**. This section defines
how reactivity boundaries interact with the query system.

### 5.11.1 asCell

`asCell(entityId)` returns a reactive cell that updates when the entity's head
changes. The cell holds the entity's current value and re-evaluates when a new
revision is committed for that entity on the target branch.

### 5.11.2 asStream

`asStream(query)` returns a reactive stream of `FactSet` updates. Each emission
contains the incremental changes since the last emission, following the
session-watch semantics defined in section 5.4.

### 5.11.3 Boundary Rules

The boundary between "data included in the parent cell" and "data in a separate
cell" is determined by the schema:

- **Top-level properties** of a queried entity are part of the parent cell's
  reactive scope. Changes to these properties trigger an update on the parent
  cell.
- **Referenced entities** (followed via links) are separate cells. Changes to a
  referenced entity trigger an update on that entity's cell, but do not
  automatically trigger an update on the referencing (parent) cell.
- **Schema-aware watches** (section 5.4.3) bridge this boundary: the schema
  tracker monitors all reachable entities, so the session sync stream emits
  updates for any change in the reachable graph.

---

## 5.12 Implementation Notes

This section documents constraints and considerations discovered during an
initial v1 → v2 migration that affect how queries and watch-based live sync are
implemented.

### 5.12.1 Schema Traversal Is a Server-Side Function

In v1, schema-guided graph traversal happens on the **server** via
`space-schema.ts` → `selectSchema()`. The server walks from root entities
through `{"/": { "link@1": {...} } }` references, guided by the JSON schema, and
returns ALL linked entities in a single query response. The client never needs
to "discover" linked entities — the server already includes them.

The client-side `SchemaObjectTraverser` in `traverse.ts` is used for
**validating and transforming** already-loaded data (e.g., in `schema.ts`), not
for discovering what to subscribe to. Any v2 query implementation must preserve
this server-side traversal pattern.

### 5.12.2 Schema Availability

Not all cells carry schemas. In the runner's `StorageManager.syncCell()`, the
selector is built as:

```typescript
// Shown for illustration only.
const selector = {
  path: cell.path.map((p) => p.toString()),
  schema: schema ?? false,
};
```

When a cell has no schema (common for many cell types), the selector becomes
`{ path: [...], schema: false }`. Per section 5.3.2, `schema: false` means
"reject — skip this subtree." A traverser with `schema: false` will not follow
any references or discover any linked entities.
