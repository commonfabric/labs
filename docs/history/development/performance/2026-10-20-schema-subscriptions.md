---
status: historical
created: 2026-10-20
archived: 2026-10-20
reason: "Investigation of permanent schema subscriptions and the smaller fetch-once path available at 4e5cb7975d0cf1b12cc7daddbe0e4aa0d0e309e2."
---

# Whether schema loading needs permanent subscriptions

A successfully fetched, verified schema document does not need a permanent
subscription. A schema change creates a different `cid:` ID. The mutable
document referencing that schema still needs its normal subscription, which
delivers the new reference. This conclusion supports a targeted change to schema
loading rather than a redesign of all subscriptions.

## What the implementation establishes

- [`engine.ts`](../../../../packages/memory/v2/engine.ts)'s content-addressed
  commit validation refuses patches, deletion, non-space scope, content that
  does not hash to its ID, and changes to an existing document's envelope.
  An identical re-set is elided. Immutability holds within the document's
  space and branch; the hash identifies `.value`, not the entire envelope.
- [`storage/v2.ts`](../../../../packages/runner/src/storage/v2.ts)'s
  `#syncCfcSchemaDocument` sends schema and label IDs through ordinary
  `provider.sync`. The remote `SpaceReplica.pull` path queues a watch refresh,
  records successful selectors in `#watchSelectorTracker`, and removes them
  only on failure in that path. Thus a one-time schema load can become an
  enduring subscription. The local store read-through already avoids watches.
- [`client.ts`](../../../../packages/memory/v2/client.ts)'s
  `SpaceSession.queryGraph` already issues a one-time `graph.query`.
  [`server.ts`](../../../../packages/memory/v2/server.ts)'s `graphQuery`
  authenticates the current session and evaluates the graph without installing
  a session watch. Query assembly includes required schema dependencies.
  No new wire message is needed to fetch without subscribing.
- The local document-interest route test fetches a schema with `queryGraph`,
  verifies its arrival, and finds no session interest. It then watches that
  schema directly in one session and watches a document referencing it in a
  second. The diagnostic attributes both, distinguishing the direct root from
  the dependency. This is a functional check, not a performance measurement.

The existing [content-addressed schema specification](../../../specs/content-addressed-schemas.md)
already lists fetch-once as deferred work. The missing piece is integrating a
one-time result into the runner's replica with the right guarantees.

## Small implementation boundary

Start with explicit schema-document loads at shared space scope, using the
existing one-time query with a root-only selector (`schema: false`). Do not
change arbitrary `pull` calls: an immutable document can reference mutable
documents whose traversal still needs reactivity.

The loader must preserve four contracts:

1. **Verified availability.** Validate the hash and transitive schema closure
   before reporting success; retain the existing quarantine behavior. A
   realm-global registry hit is not evidence that this space persists the
   document, and a pending local write is not a confirmed server copy.
2. **Arrival after absence.** An absent ID is not permanently absent. Keep
   today's watch behavior for missing or incomplete results until a verified
   complete copy arrives, or provide an equally explicit retry mechanism.
   Failures must remain retryable. Deduplicate concurrent fetches without
   allowing a caller to finish before integration.
3. **Delivery accounting.** Integrate confirmed document snapshots without
   declaring that unrelated watched data is complete through the query's
   server sequence. Preserve session revocation/remount checks. Reconnect
   holdings, watch replacement removals, and locally retained immutable data
   need an explicit boundary; routing a query result through a fabricated
   subscription frame is not automatically correct.
4. **Subscription ownership.** A temporary fallback watch must leave both the
   server watch set and the client's reconnect intent when released.
   `watchRemoveSync` already supports that transport operation, but the
   runner's selector tracker and cached data must agree with it. Do not
   release another caller's mutable traversal interest in the same document.

Tests for a follow-up should cover nested schema references, concurrent loads,
absence followed by installation, rejected or quarantined contents, revocation,
reconnect, and an immutable document referencing mutable data.

## What this would and would not resolve

Fetch-once would stop explicit schema loads from adding permanent roots and
replaying those roots on reconnect. It would not remove schema dependencies
still required by ordinary watched documents, nor make historical schemas
smaller. The measured benefit depends on how many interests are redundant
direct roots versus dependencies; the document-interest diagnostic exposes
that distinction.

There are also independent retention owners. The
[`schema registry`](../../../../packages/runner/src/schema-registry.ts)
holds strong references across overlapping runtime leases, and a server realm
without leases retains them for its process lifetime. Query evaluation and
engine caches can also retain documents without a session watch. Fetch-once is
therefore a bounded reduction in recurring subscription work, not a complete
heap bound or proof that it alone prevents the investigated OOM.

The diagnostic and this investigation leave production and subscription
semantics unchanged. Identifying a historical schema in a session does not
establish that the client is running an old build.
