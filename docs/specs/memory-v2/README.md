# Memory v2 Specification

A complete redesign of the Memory system: a persistent, transactional,
branch-aware store with optimistic local commits, seq-based validation, and
session-scoped catch-up sync.

## Design Goals

1. **Clean break in storage semantics** — No backward compatibility with the v1
   database or internal storage model. During migration, high-level cutover
   interfaces may remain stable while the implementation underneath them is
   replaced.
2. **Boring nomenclature** — Replace the cute v1 terms (`the`, `of`, `since`,
   `cause`) with standard ones (`id`, `seq`, `branch`). Drop the `the` dimension
   entirely.
3. **Incremental changes** — Transactions support patches (JSON Patch + splice
   extension), not just whole-document replacement.
4. **Seq-addressed JSON history** — JSON entity history is keyed by branch,
   entity id, and seq. Semantic commit/fact/value hashes are removed from the
   JSON write path. Only UCAN envelopes and blobs remain content-addressed.
5. **Point-in-time retrieval** — Read any entity's state at any seq number on
   any branch.
6. **Branching** — Lightweight branches with isolation, merging, and conflict
   detection. Branches share revision history and global ordering.
7. **Optimistic commit model** — Local commits are synchronous and optimistic.
   The server confirms asynchronously, with seq-based validation and explicit
   pending-read resolution.
8. **Session-scoped catch-up sync** — The server tracks what a session has
   already integrated and pushes catch-up frames for the union of the session's
   active interests, rather than routing updates through individual
   subscriptions. On a reconnect the client's own statement of what it holds
   takes that tracking's place as the diff base, so the catch-up re-delivers
   exactly what the client lacks.
9. **Schema-based traversal** — Graph queries follow JSON Schema-defined
   references, reusing `traverse.ts` patterns (cycle detection, schema
   narrowing).

## Nomenclature

| v1 Term                | v2 Term                       | Description                                                                                               |
| ---------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `the`                  | _(dropped)_                   | Was always `application/json`. No type dimension in v2.                                                   |
| `of`                   | `id`                          | Entity identifier (URI)                                                                                   |
| `since`                | `seq`                         | Monotonic sequence number (Lamport clock)                                                                 |
| `cause`                | _(dropped from wire/storage)_ | Seq-based validation replaces client-supplied parent hashes in the JSON write path                        |
| `is`                   | `value`                       | The JSON data                                                                                             |
| `Unclaimed`            | `Empty`                       | Genesis state before any writes                                                                           |
| `Assertion`            | `Write` (`set` or `patch`)    | A state transition that sets/patches a value                                                              |
| `Retraction`           | `Delete`                      | Tombstone transition                                                                                      |
| `Changes`              | `Operation[]`                 | Flat list of typed operations                                                                             |
| `Selection`            | `FactSet` / session cache     | Query result set or the session's integrated entity cache                                                 |
| `Selector`             | `Query` / `Selector`          | Query pattern                                                                                             |
| `datum` table          | _(dropped)_                   | JSON values are stored inline on revisions/snapshots                                                      |
| `memory` table         | `head` table                  | Current state pointer per entity per branch                                                               |
| Heap                   | Confirmed                     | Server-acknowledged client state                                                                          |
| Nursery                | Pending                       | Optimistic unconfirmed client state                                                                       |
| `IStorageSubscription` | `IStorageNotificationSink`    | Scheduler notification interface (commit/integrate events). Renamed to avoid confusion with v2 data sync. |
| `StorageSubscription`  | `StorageNotificationRelay`    | Implementation class for scheduler notifications                                                          |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Client                                │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │  Confirmed   │  │   Pending    │  │   Client Library   │  │
│  │  (seq,       │  │  (stacked    │  │  connect()         │  │
│  │   value)     │  │   commits,   │  │  session.transact()│  │
│  │              │  │   localSeq)  │  │  session.watchSet()│  │
│  │              │  │              │  │  session.query()   │  │
│  └──────────────┘  └──────────────┘  └─────────┬─────────┘  │
│                                                 │            │
└─────────────────────────────────────────────────┼────────────┘
                                                  │ WebSocket
┌─────────────────────────────────────────────────┼────────────┐
│                       Server                    │            │
│                                                 ▼            │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                   Protocol Layer                        │ │
│  │  UCAN auth, session tracking, watch-set management      │ │
│  └────────────────────────┬────────────────────────────────┘ │
│                           │                                  │
│  ┌────────────────────────▼────────────────────────────────┐ │
│  │                   Commit Engine                         │ │
│  │  Seq-based validation, atomic apply, conflict handling  │ │
│  └────────────────────────┬────────────────────────────────┘ │
│                           │                                  │
│  ┌────────────────────────▼────────────────────────────────┐ │
│  │                   Storage (SQLite)                      │ │
│  │  revision | head | commit | snapshot | branch           │ │
│  │  invocation | authorization | blob_store                │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                   Query Engine                          │ │
│  │  graph.query traversal, session sync, point-in-time     │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

## Sections

| Section | File                                                               | Content                                                                                                                           |
| ------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 1       | [01-data-model.md](./01-data-model.md)                             | Entities, operations, patches, blobs, metadata, snapshots, type system, and system entities                                       |
| 2       | [02-storage.md](./02-storage.md)                                   | SQLite schema, revision log, read path, snapshot creation, branch storage, point-in-time reads, and garbage collection            |
| 3       | [03-commit-model.md](./03-commit-model.md)                         | Operations, transactions, confirmed/pending state, validation, stacked commits, and seq-based replay/session identity             |
| 4       | [04-protocol.md](./04-protocol.md)                                 | WebSocket transport, session open/resume, session sync effects, commands (transact/query/watch/branch), UCAN auth, and client API |
| 5       | [05-queries.md](./05-queries.md)                                   | One-shot queries, schema traversal, point-in-time reads, watch sets, and session-scoped catch-up sync                             |
| 6       | [06-branching.md](./06-branching.md)                               | Branch lifecycle, isolation, merging, conflict resolution, point-in-time reads on branches, and branch diffs                      |
| 7       | [07-op-views-and-annotations.md](./07-op-views-and-annotations.md) | Live contract for atomic collaborative operations, submitted/integrated/materialized projections, cursors, and anchors           |
| 8       | [08-conflict-granularity.md](./08-conflict-granularity.md)         | How commit-time conflict detection decides read/write overlap, and the granularity refinements                                    |
| 9       | [09-invariants.md](./09-invariants.md)                             | Normative catalog of end-to-end consistency invariants (INV-1..INV-14), soundness directions, and the checkers that guard them    |

The invariant catalog is backed by bounded TLA+ models of pending-stack
commits, local folds, and session delivery in [tla/](./tla/README.md). Each
model states the behavior it checks and the composition it leaves outside
its bounds.

[connection-multiplexing.md](./connection-multiplexing.md) is a proposed design
for carrying every space's sessions over one connection per host, acting as a
second identity on that connection, and routers in front of several toolsheds.

## Implementation Materials

For the current shipped implementation status and explicitly deferred items, use
the implementation plan and guidance below rather than inferring status from the
broader target sections.

| File                                                             | Content                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| [implementation-plan.md](./implementation-plan.md)               | Current implementation status, shipped scope, deferred items, and focused test coverage |
| [10-implementation-guidance.md](./10-implementation-guidance.md) | Architectural guidance, known pitfalls, phasing, and anti-patterns |
| [../../plans/memory-apply-op.md](../../plans/memory-apply-op.md)  | In-progress implementation sequence for `apply-op`, the CodeMirror codec, and editor-neutral operation sessions |

## Key Type Summary

```typescript
// Shown at module scope.
type EntityId = string;
type BranchId = string;
type SessionId = string;
type ReadPath = readonly string[];
type Reference = string & { readonly __brand: unique symbol };
type FabricValue = unknown; // Abbreviated here; see 01-data-model.md.

interface SetOperation {
  op: "set";
  id: EntityId;
  value: JSONValue;
}

interface PatchWriteOperation {
  op: "patch";
  id: EntityId;
  patches: PatchOp[];
}

interface DeleteOperation {
  op: "delete";
  id: EntityId;
}

type Operation = SetOperation | PatchWriteOperation | DeleteOperation;

interface ConfirmedRead {
  id: EntityId;
  branch?: BranchId;
  path: ReadPath;
  seq: number;
}

interface PendingRead {
  id: EntityId;
  path: ReadPath;
  localSeq: number | number[];
  basisSeq?: number;
}

interface ClientCommit {
  localSeq: number;
  reads: {
    confirmed: ConfirmedRead[];
    pending: PendingRead[];
  };
  operations: Operation[];
  codeCID?: Reference;
  branch?: BranchId;
  merge?: {
    sourceBranch: string;
    sourceSeq: number;
    baseBranch: string;
    baseSeq: number;
  };
}

interface StoredRevision {
  branch: BranchId;
  id: EntityId;
  seq: number;
  opIndex: number;
  op: "set" | "patch" | "delete";
  data?: JSONValue | PatchOp[];
  commitSeq: number;
}

interface Commit {
  seq: number;
  branch: BranchId;
  sessionId: SessionId;
  localSeq: number;
  original: ClientCommit | BranchLifecycleWrite;
  resolution: {
    seq: number;
    resolvedPendingReads?: Array<{ localSeq: number; seq: number }>;
  };
  invocationRef: Reference | null;
  authorizationRef: Reference | null;
  revisions: StoredRevision[];
  createdAt: string;
}

interface SigilLink {
  "/": { "link@1": { id?: string; path?: string[]; space?: string } };
}

// `source` is an `EntityRef` (serialized short-link form `{"/":"<short-id>"}`);
// an arbitrary document field is a `FabricValue`. The former `SourceLink` /
// `EntityDocumentField` aliases are no longer separate types.
interface EntityDocument {
  value?: FabricValue;
  source?: EntityRef;
  pattern?: SigilLink;
  argument?: SigilLink;
  internal?: SigilLink;
  result?: SigilLink;
  schema?: FabricValue;
  slug?: string;
  [key: string]: FabricValue;
}

interface WatchSpec {
  id: string;
  kind: "query" | "graph";
  query: Query | SchemaQuery;
}

interface SessionSync {
  fromSeq: number;
  toSeq: number;
  upserts: Array<{
    branch: BranchId;
    id: EntityId;
    seq: number;
    doc?: EntityDocument;
    deleted?: true;
  }>;
  removes: Array<{ branch: BranchId; id: EntityId }>;
}
```

Current implementation note:

- plain `/memory/transact` commits leave `invocationRef` /
  `authorizationRef` unset
- `session.open` remains the authenticated edge in this pass
- ACL genesis is an explicit transaction authorized by the space identity (or
  a configured service DID), not a side effect of `session.open`
- a never-ACL'd populated space is temporarily authenticated-public READ/WRITE;
  a fresh space is READ-only until genesis, and malformed/ownerless/retracted
  ACL state fails closed
- signed per-commit invocation / authorization metadata remains deferred until
  transport-level verification lands

The semantic JSON write path itself is seq-addressed rather than hash-addressed.

## System Entity Conventions

With the removal of the `the` dimension, system-level data (ACLs, schemas, blob
metadata) is stored as regular entities with well-known ID conventions:

| Entity Type         | ID Pattern             | Example                 |
| ------------------- | ---------------------- | ----------------------- |
| Access Control List | `<space-did>`          | `did:key:z6Mk...`       |
| Schema              | `urn:schema:<name>`    | `urn:schema:contact`    |
| Blob Metadata       | `urn:blob-meta:<hash>` | `urn:blob-meta:bafk...` |

These are regular entities. They benefit from versioning, causal validation,
branch isolation, and session-scoped sync without a separate storage dimension.

## Related Cross-Cutting Specs

| File | Content |
| ---- | ------- |
| [Scoped Cell Instances](../scoped-cell-instances.md) | Scope dimensions for causal cell ids across storage, links, schemas, traversal, and built-ins |
