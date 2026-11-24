# CF Protocol: Capabilities API (Section 6)

See the [verifiable-execution document map](README.md) for navigation.

## 6. Capabilities API

This section describes the high-level operations the memory protocol supports,
in terms of the invocation envelope this specification is written around. It is
a design-level account, not a transcript of the wire: the shapes a client and
server actually exchange are defined by the Memory v2 protocol
([`docs/specs/memory-v2/04-protocol.md`](../memory-v2/04-protocol.md)) and
declared in `runtime/memory/v2.ts`. Read this section for the operations and
their semantics, and that one for what goes over a socket.

### 6.0 Notes on Current Implementation

- **Delegation:** `Invocation.prf` exists for a future delegation model.
  Delegation is not implemented, so `prf` is empty in practice, and a
  participant's access comes directly from the space's access-control list.
- **Subscriptions:** The current subscription commands are
  `"/memory/query/subscribe"` and `"/memory/query/unsubscribe"`.
- **Schema-aware retrieval:** Implementations also support schema-guided
  selection via `SchemaSelector` and graph queries at `"/memory/graph/query"`.
- **Classification claims:** Schema/graph queries accept a `classification`
  claim that gates access to labeled entities in the current implementation.

### 6.1 `/memory/transact`

Atomically assert, retract, or claim facts in a space.

**Request (shape):**

```typescript
// Shown at module scope.
type Transaction = {
  iss: DID;
  cmd: "/memory/transact";
  sub: MemorySpace;
  args: { changes: Changes };
  prf: Delegation[]; // currently always []
  // plus optional: aud, exp, iat, meta, nonce
};
```

**Processing (conceptual):**

1. Validate authorization (if enabled for the space)
2. Validate all `cause` references (CAS)
3. Apply all changes atomically or reject entirely
4. Record a commit in the append-only log

**Response (current semantics):** a successful transaction returns the commit
fact (and may include label facts for redaction/access control). Failures return
structured errors such as `ConflictError`, `AuthorizationError`, etc.

**Conflict errors:** On CAS conflict, the current implementation returns a
structured `ConflictError` including the conflicting address and both the
expected and actual states (see `runtime/memory/interface.ts`).

### 6.2 `/memory/query`

Retrieve facts from a space, optionally at a specific logical time.

**Request (shape):**

```typescript
// Shown at module scope.
type Query = {
  iss: DID;
  cmd: "/memory/query";
  sub: MemorySpace;
  args: { select: Selector; since?: number };
  prf: Delegation[]; // currently always []
};
```

**Wildcards:** The selector type supports `_` as a wildcard key, matching any
value at that level. For example:

- `{ "_": { "_": { "_": { is: {} } } } }` - include values for all facts
- `{ "user:alice": { "_": { "_": { is: {} } } } }` - all facts for user:alice
- `{ "_": { "application/json": { "_": { is: {} } } } }` - all JSON facts

**CFC note:** When CFC/IFC is enabled, implementations MAY redact classified
values (including at path granularity, as defined by schemas) by omitting `is`
fields and/or returning a filtered value.

### 6.3 `/memory/query/subscribe`

Receive push-based updates for facts matching a selector.

**Request (conceptual):** an invocation with `cmd: "/memory/query/subscribe"`
and either `args.select` (normal selector) or `args.selectSchema` (schema/path
selector), plus an optional `since` cursor.

**Updates:** The subscription stream delivers updates over time, each carrying
the committed revisions and the commit that produced them. Each update MUST
respect the subscriber's authorization and CFC/IFC context (e.g., via
redaction).

### 6.4 `/memory/query/unsubscribe`

Stop a subscription started via `"/memory/query/subscribe"` by providing its
`source` invocation reference.

### 6.5 `/memory/graph/query` (Schema-Guided Retrieval)

Schema-guided graph query supports returning a set of reachable facts based on
schema traversal rules (see `docs/specs/json_schema.md`). It is the primary
mechanism for “pulling a document and the cells it links to” without fetching
the entire reachable graph.

**Classification claim:** The `classification?: string[]` argument is a
declarative claim used to gate access to labeled entities in the current
implementation (see `runtime/memory/space-schema.ts`).

**Subscribe mode:** When `subscribe: true`, the query registers schema-tracked
dependencies for incremental updates. Subsequent fact revisions are delivered
via the commit stream (`"/memory/query/subscribe"`) rather than via a separate
graph-query push channel.

---

Prev: `docs/specs/verifiable-execution/02-commit-model.md`  
Next: `docs/specs/verifiable-execution/04-receipts.md`
