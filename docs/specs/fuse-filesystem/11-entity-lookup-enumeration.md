# 11. Entity Lookup, Enumeration, and Performance

This document defines the performance contract for the raw `entities/` view.
It separates three operations that have very different costs:

- **exact lookup** addresses one entity whose full ID is already known;
- **enumeration** discovers every live space-scoped entity ID; and
- **hydration** reads one entity value and builds its projected subtree.

Keeping those operations separate is the central constraint. Identifier-only
enumeration must never turn into an implicit read of every entity value.

The implementation keeps these operations separate at the storage protocol,
FUSE directory-handle, and in-memory projection layers. Mounting does not list
identifiers. Enumeration uses stable protocol pages owned by one directory
handle. Exact lookup uses a point-existence request. Directory enumeration
below an entity ID does not hydrate its value.

## Addressing and Discovery

An exact path has the form:

```text
<mountpoint>/<space>/entities/<encoded-entity-id>/...
```

The full entity ID is the address. Directory enumeration is a discovery aid,
not a prerequisite for interpreting that address. An open `entities/` handle
owns virtual directory entries for the identifiers it discovered. Those
entries do not create one permanent inode per identifier.

The Memory v2 `entity-id.list` operation is the complete discovery source for
servers that advertise `entityIdListing`. It returns sorted, live entity IDs
from the default branch and space scope. It excludes deleted, user-scoped, and
session-scoped entities. The operation is authorized as a space `READ`.
Servers that advertise `entityIdPagination` accept a cursor, a capped page
size, and the server sequence from the first page.

The operation deliberately returns IDs rather than entity documents. Complete
discovery is still inherently linear in the number and encoded length of live
IDs: the server must produce them, the wire must carry them, and FUSE must
represent their names. "Identifier-only" means that this work is independent
of entity value size; it does not mean enumeration is constant-cost.

### Exact lookup

`entity-id.exists` checks one canonical ID against the same live-head index as
enumeration. It returns liveness and the current server sequence without
selecting a revision or entity document. A cold exact lookup therefore does
not list unrelated identifiers. A missing ID returns missing without changing
the projection cache.

A successful lookup creates one empty projected directory. The bridge keeps a
least-recently-used cache of at most 128 exact entity projections by default.
The limit includes hydrated projections. Projections with kernel lookup
references, open file handles, open directory handles, or in-flight hydration
remain pinned. The cache may exceed its configured limit by the number of
pinned projections and returns to the limit as those references close.
Lookup preparation reserves the kernel reference before returning an inode to
the reply callback. This keeps concurrent asynchronous lookups from evicting a
projection that another callback has prepared but not yet returned. If
libfuse rejects an entry, open, or create reply, the callback releases the
reserved lookup reference or handle immediately.
Pinned projections are absent from the eviction-candidate set. A kernel that
retains many lookup references therefore does not make each later lookup scan
all earlier projections. Per-root owner indexes also let final cleanup visit
only the retained descendant inodes that belong to that root.
Eviction removes the projected tree, its controller, subscriptions, and CFC
entry metadata. Enumeration remains complete because its names live in the
open directory handle rather than this cache.

Deletion and eviction remove the directory entry immediately. A referenced
inode subtree remains available by inode until its final lookup and open
references close. This matches the FUSE lifetime rule and prevents an open
directory or file from changing to `ENOENT` because unrelated entity lookups
filled the projection cache. Reference bookkeeping records each retained
inode's projection root when the reference is created. Releasing a descendant
still finds that root after a reactive update has removed the descendant's
parent link.

Mount connection creates only the space's fixed synthetic files and
directories. It does not request identifiers, the space root, the default
pattern, the piece registry, or any entity value. Its storage and inode cost is
independent of the number of live entities.

## Hydration Boundary

An exact projection starts as an empty synthetic directory. These operations remain
identifier-only:

- connecting the space;
- listing `entities/`;
- looking up or stating an exact entity-ID projection; and
- opening exact entity-ID directories discovered by a recursive walker.

Directory reads of an entity root and its `input` and `result` roots return
only `.` and `..`. They do not load the entity. A direct lookup of a named
child, such as `meta.json`, `result.json`, or `result/title`, crosses the
hydration boundary. The bridge loads only that entity through
`PiecesController.get()` and then prepares the named projection. Hydration can
transfer and retain bytes proportional to that entity value.

Once hydrated, an entity-only projection subscribes to its input, result, and
pattern metadata. External changes rebuild the retained projection in place.
Eviction or deletion cancels these subscriptions.

### Recursive crawlers

A recursive walker may look up and open every entity-ID directory, but it sees
no child names to follow. This makes `find`, IDE indexers, backup scanners, and
other metadata crawlers identifier-only. They can issue one point-existence
request per ID, but they do not issue entity, input, or result value reads.

Directly named access remains available for callers that know the projection
path. Tests and benchmarks count entity, input, and result requests directly
rather than inferring the boundary from the absence of a familiar payload
string. The FUSE integration suite also records server-to-client Memory frames
while a kernel-mounted filesystem lists every direct child of `entities/`. It
requires the known entity ID in those frames and rejects the entity's seeded
payload marker.

## Directory Handles and FUSE Pagination

One userspace directory read is commonly split across several low-level FUSE
`readdir` callbacks. The kernel supplies an offset and a finite output buffer;
the daemon returns as many entries as fit, then receives a continuation call.
These callbacks are pagination of one open directory, not independent requests
to rediscover the directory.

The daemon tracks preparation per directory file handle:

1. `opendir` allocates a directory handle.
2. The first `readdir` for that handle prepares the dynamic directory. For
   `entities/`, preparation requests stable identifier pages and stores virtual
   directory entries on the handle. Concurrent preparations for the same space
   share one in-flight scan and one immutable entry array.
3. Continuation `readdir` calls for the same handle read the already prepared
   in-memory directory and do not issue another identifier-list request.
4. `releasedir` discards the handle state.
5. A later `opendir` gets a new handle and may refresh the identifier set.

Preparation failures do not mark a handle prepared. The next operation on that
handle may try again after the caller observes the failure. This is not an
internal retry loop or a time-based poll.

This handle rule prevents a large listing from accidentally becoming
quadratic: without it, a directory spanning P FUSE buffers would transfer the
same O(N) identifier response P times. It also defines the freshness boundary
for pull-based identifier discovery. One handle observes one prepared view;
new opens can observe additions and deletions. Subscription-driven updates may
still invalidate live tree entries as described in
[Reactivity and Caching](./6-reactivity.md).

The first page fixes `serverSeq`. Every later page sends that value as
`expectedServerSeq`. A change fails with `SnapshotChangedError`; the bridge
does not restart or retry the scan. The server caps each page at 1,000 IDs.
The FUSE handle publishes no partial listing when any page fails.

## CFC Entry Metadata

Virtual enumeration entries do not create CFC-annotated inodes. Exact
projections receive the same CFC node and directory-entry annotations as other
projected trees, and their count is bounded by the projection cache.

`FsTree` also batches CFC directory-entry ordering for wide projected JSON
objects. Adding or replacing an entry updates a parent-local name index and
appends to its pending entry array. Reading the CFC annotation sorts the array
once by name digest and rebuilds the index. Removing an entry uses the same
index. Building a directory with many annotated children therefore avoids
copying and sorting the complete entry array after every child insertion.

## Storage Live-ID Index

Entity values and current identifier liveness have different access patterns.
A value read needs the current revision data. Identifier enumeration needs only
the compact tuple `(branch, scope, id, current operation)`.

The `head` table therefore stores the current operation (`set`, `patch`, or
`delete`) beside its revision pointer. A partial covering index over live heads
supports sorted space-scope enumeration without joining the JSON-bearing
`revision` table:

```sql
CREATE INDEX idx_head_live_entity_ids
ON head (branch, scope_key, id, op)
WHERE op <> 'delete';
```

The list query reads `head`, filters the default branch and space scope, and
orders by ID. Keeping the current operation in `head` matters for two reasons:

1. it avoids one `revision` index probe per head; and
2. the partial index excludes retained tombstones, so listing cost scales with
   live IDs rather than every ID that ever existed in the space.

Existing databases backfill `head.op` from the current revision during schema
migration. Set, patch, and delete operations update the revision pointer and
operation atomically thereafter. Entity payload bytes remain solely in the
revision path and are not selected, decoded, or returned by ID enumeration.

## Measured Baseline

The scheduled benchmark workflow runs these diagnostic benchmarks. Their
results show trends but do not cause changes to fail CI:

- `runtime/fuse/entity-projection.bench.ts` measures bounded exact-projection
  churn, the first paginated directory view, repeated refresh, batched CFC
  directory annotations, and a recursive metadata walk with a fake manager;
  and
- `runtime/memory/test/v2-entity-id-list.bench.ts` measures the SQLite list
  query across live-count, payload-size, and tombstone-count fixtures, and
  compares it with the live-head index.

Representative commands are:

```bash
deno task --cwd runtime/fuse bench:entity-projection
deno task --cwd runtime/memory bench:entity-id-list
```

The workflow's JSON artifact records only the operations named by each
benchmark. Fixture construction, forced garbage collection, and diagnostic
measurement happen outside those timers. Heap, request-count, response-size,
and independently measured wall-time diagnostics go to stderr. The workflow
stores them in `diagnostics.log` beside the JSON results. Each FUSE diagnostic
includes an invocation number and labels Deno's first invocation as `warmup`.
Later `measured` invocations correspond to the samples summarized in JSON.

The measurements below were collected on 2026-07-22 with Deno 2.8.x. Ranges
come from the measured invocations in a local run. They are evidence about
scaling and relative cost, not portable latency budgets.

### FUSE projection

Mount construction now creates eight fixed inodes, transfers no identifiers,
and makes no list request. The historical `stubs-*` benchmark series now
measures a stream of targeted exact lookups so the chart keeps its existing
series names while exercising bounded projection churn:

| Exact lookups | CFC off | CFC on | Final inodes | List requests |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 6.2–7.4 ms | 9.4–9.9 ms | 136 | 0 |
| 10,000 | 62.6–66.3 ms | 91.9–92.9 ms | 136 | 0 |
| 100,000 | 603.5–630.3 ms | — | 136 | 0 |

Each row issued one point-existence request per lookup. The final inode count
stayed fixed because only the 128 most recently used exact projections
remained. CFC annotations add work per projection but no longer make retained
state proportional to the space's live-entity count.

The first `entities/` directory read retains one virtual entry object per ID on
the open handle. It does not add those entries to `FsTree`:

| Live IDs | First directory view | Protocol pages | ID response | Tree inodes |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 0.8–1.4 ms | 1 | about 0.1 MiB | 8 |
| 10,000 | 12.4–12.7 ms | 10 | about 0.6 MiB | 8 |
| 100,000 | 119.7–120.3 ms | 100 | about 5.5 MiB | 8 |

The snapshot remains live until `releasedir`. Handles whose first reads overlap
share the same immutable snapshot rather than multiplying the complete scan and
entry array. A later handle still performs a fresh scan. Snapshot memory is
linear in the listing size and has the same lifetime as the last sharing
directory handle. No permanent identifier-inode tree remains after the handles
close.

The recursive-walk fixture listed and opened 1,000 entity directories. It made
one paginated list request and 1,000 point-existence requests. It made zero
entity gets, zero input gets, and zero result gets. The exact-projection cache
left 136 total inodes. Measured walks took 4.9–6.0 ms with the fake manager.

The CFC batching benchmark built wide annotated directories and forced one
metadata read at the end. A 1,000-entry directory took 3.7–4.7 ms, and a
10,000-entry directory took 39.0–40.9 ms. This replaces the prior repeated
copy-and-sort behavior, which took more than a second at 10,000 entries.

The fake transport excludes database time, network framing, JSON decoding,
and FUSE buffer-copy cost. The measurements establish scaling shape rather
than deployment latency.

### Storage query

Representative former-query and live-head medians were:

| Fixture | Former head/revision join | Live-head index |
| --- | ---: | ---: |
| 1,000 live, 16-byte payload | — | 0.247 ms |
| 10,000 live, 16-byte payload | — | 2.9 ms |
| 100,000 live, 16-byte payload | 82.4 ms | 24.2 ms |
| 10,000 live, 4 KiB payload | — | 1.8 ms |
| 1,000 live + 99,000 tombstones | 68.8 ms | 0.185 ms |

Absolute values varied between runs, but the ratios were stable. The 4 KiB
payload fixture remained comparable to the small-payload fixture, confirming
that values were not decoded. Tombstones were the dominant defect: the former
join scaled with 100,000 lifetime heads even when only 1,000 were live.

`EXPLAIN QUERY PLAN` made the cause explicit. The former query searched `head`
and then searched `revision` by its primary-key index for every row. The
live-head form searches only `idx_head_live_entity_ids` by branch and scope.
The index reduced the 100,000-live fixture by roughly 3.4x and the
tombstone-heavy fixture by over two orders of magnitude. Rebuilding a local
100,000-head tombstone-heavy database with the current migration took about
93 ms in one run. This is a one-time, open-time write-lock cost rather than
steady-state listing work.

## Acceptance Invariants

Changes to the entity projection must preserve all of the following:

1. **No value transfer during discovery.** Space connection, top-level
   `entities/` preparation, and recursive directory-only traversal issue zero
   entity-value reads.
2. **One preparation per handle.** FUSE continuation offsets for one open
   directory do not repeat identifier discovery. A new handle may refresh.
3. **Linear, live-set storage work.** The query plan uses the live-head index,
   does not access `revision`, and does not scan tombstones.
4. **Value-size independence.** Increasing entity payload size does not change
   the logical list result or cause payload decoding. Tests should inspect
   response structure and request counts as well as payload sentinels.
5. **Explicit hydration.** Only direct lookup of a named projected child
   hydrates an entity. Opening entity, input, or result directories hydrates
   none.
6. **Deletion correctness.** A refreshed identifier snapshot removes deleted
   cached projections and their indexes. Point lookup rejects a cached ID once
   the live-head index reports it missing.
7. **Bounded failure behavior.** A failed page publishes no partial directory
   snapshot and does not poison its handle. Callers may retry the failed
   operation; the daemon does not run a hidden retry loop.
8. **Capability-safe compatibility.** A client never sends paginated list or
   point-lookup requests unless the server advertises their capabilities.
9. **Bounded retained projection state.** Enumeration does not add permanent
   identifier inodes. Unreferenced exact and hydrated entity projections obey
   the configured cache limit. Referenced projections are removed after their
   lookup and open references close. Interrupted FUSE replies do not retain
   lookup references or handles.

Performance tests should prefer deterministic counters and query-plan
assertions over wall-clock CI thresholds. Useful scale fixtures are 1,000,
10,000, and 100,000 live IDs; a tombstone fixture should hold the live count
constant while increasing lifetime heads by at least 100x. A recursive fixture
must report entity, input, and result request counts explicitly.

## Older Servers

An older Memory v2 server may omit `entityIdListing`, `entityIdPagination`, or
`entityIdLookup`; each omission parses as `false`. The client does not send an
unknown request. Connecting the space never falls back to reading the space
root, default pattern, or piece registry.

FUSE enumeration requires both identifier listing and pagination. Opening
`entities/` fails when either capability is absent. It does not accept one
unbounded response. The separate compatibility list API remains available to
legacy callers, but the server rejects an unpaginated result larger than 1,000
IDs. A server without point lookup can resolve only exact projections already
cached in the bridge or known piece controllers. It does not refresh the
complete identifier list for one missing name.

Connection health does not depend on these optional capabilities. A healthy
older server can reconnect even though a later attempt to enumerate
`entities/` will report that pagination is unsupported.

If the caller later opens `pieces/`, the piece-registry projection is
materialized. The resulting known controllers can support exact entity access,
but they do not change the `entities/` enumeration. Absence of a capability
never triggers a hidden space-wide value scan.

---

**Previous:** [CFC Filesystem API Semantics](./10-cfc-filesystem-api-semantics.md)
