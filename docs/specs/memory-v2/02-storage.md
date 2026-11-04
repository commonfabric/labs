# 02 — Storage

This section defines the SQLite schema, indexing strategy, revision and snapshot
storage design, branch representation, point-in-time read algorithm, and
operational configuration.

The key storage change in this revision is that JSON entity history is no longer
content-addressed. Instead, committed JSON state is represented by:

- an append-only `commit` log keyed by canonical `seq`
- an append-only `revision` log keyed by `(branch, id, seq, op_index)`
- a `head` table for current branch-local pointers
- periodic `snapshot` rows storing full materialized entity documents

When present, invocation/auth blobs and raw binary blobs remain
content-addressed.

## 1. Database-per-Space

Each space gets its own dedicated SQLite database file:

```text
<storage_root>/<did>.sqlite
```

This keeps spaces isolated and lets WAL mode operate independently per space.

## 2. SQLite Pragmas

Every database connection applies the following pragmas:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA cache_size = -64000;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;
PRAGMA foreign_keys = ON;
```

For newly created databases:

```sql
PRAGMA page_size = 32768;
```

## 3. Tables

### 3.1 `revision` — Sequenced JSON History

Stores every entity mutation as an append-only revision row.

```sql
CREATE TABLE revision (
  branch      TEXT    NOT NULL DEFAULT '',
  id          TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  op_index    INTEGER NOT NULL,
  op          TEXT    NOT NULL,  -- 'set' | 'patch' | 'delete'
  data        JSON,              -- full document for set, patch list for patch, NULL for delete
  commit_seq  INTEGER NOT NULL,

  PRIMARY KEY (branch, id, seq, op_index),
  FOREIGN KEY (commit_seq) REFERENCES commit(seq)
);

CREATE INDEX idx_revision_branch_seq ON revision (branch, seq);
CREATE INDEX idx_revision_entity_seq ON revision (branch, id, seq);
CREATE INDEX idx_revision_commit ON revision (commit_seq);
```

Notes:

- `seq` is the global commit order for the space.
- `op_index` preserves operation order within one transaction.
- For `set`, `data` stores the full `EntityDocument`.
- For `patch`, `data` stores the serialized patch list.
- For `delete`, `data` is `NULL`.
- The storage/transaction layer operates on full-document paths. Only the
  query/traversal layer treats selector paths as value-relative and re-roots
  them through `["value", ...path]`.
- `data`, `original`, `resolution`, `invocation`, `authorization`, and
  `snapshot.value` are serialized at the persistence boundary with the shared
  FabricValue JSON codec, not with ad hoc `JSON.stringify` calls in the middle of
  replica/transaction logic.

### 3.2 `head` — Current State Pointer

Tracks the latest visible revision for each entity on each branch.

```sql
CREATE TABLE head (
  branch       TEXT    NOT NULL,
  id           TEXT    NOT NULL,
  seq          INTEGER NOT NULL,
  op_index     INTEGER NOT NULL,

  PRIMARY KEY (branch, id)
);

CREATE INDEX idx_head_branch ON head (branch);
```

The `head` table is a pointer only. The full current value is reconstructed from
the nearest snapshot at or before `seq`, then by replaying later revisions.

At this layer the reconstructed value is the full stored document object, not a
special runner-side `StorageValue` projection.

### 3.3 `commit` — Sequenced Write Log

Records every successful write-class command.

```sql
CREATE TABLE commit (
  seq                INTEGER NOT NULL PRIMARY KEY,
  branch             TEXT    NOT NULL DEFAULT '',
  session_id         TEXT    NOT NULL,
  local_seq          INTEGER NOT NULL,
  invocation_ref     TEXT,
  authorization_ref  TEXT,
  original           JSON    NOT NULL,
  resolution         JSON    NOT NULL,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),

  FOREIGN KEY (invocation_ref) REFERENCES invocation(ref),
  FOREIGN KEY (authorization_ref) REFERENCES authorization(ref)
);

CREATE INDEX idx_commit_branch ON commit (branch);
CREATE UNIQUE INDEX idx_commit_session_local_seq
  ON commit (session_id, local_seq);
CREATE INDEX idx_commit_invocation_ref ON commit (invocation_ref);
```

`original` stores the canonical semantic payload:

- `ClientCommit` for `/memory/transact`
- normalized branch lifecycle payloads for `/memory/branch/create` and
  `/memory/branch/delete`

`resolution` stores server-side decisions:

```json
{
  "seq": 42,
  "resolvedPendingReads": [
    { "localSeq": 4, "seq": 40 }
  ]
}
```

Current implementation note:

- plain `/memory/transact` commits leave `invocation_ref` /
  `authorization_ref` unset
- those columns are reserved for a later signed-write pass or for legacy rows
  carried forward from earlier builds

### 3.4 `snapshot` — Materialized Entity Values

Stores full materialized entity documents at selected seqs to avoid replaying
the full revision chain on every read.

```sql
CREATE TABLE snapshot (
  branch  TEXT    NOT NULL DEFAULT '',
  id      TEXT    NOT NULL,
  seq     INTEGER NOT NULL,
  value   JSON    NOT NULL,

  PRIMARY KEY (branch, id, seq)
);

CREATE INDEX idx_snapshot_lookup ON snapshot (branch, id, seq);
```

`value` contains the full `EntityDocument`, not just `value`.

### 3.5 `branch` — Branch Metadata

Tracks branch lifecycle and fork points.

```sql
CREATE TABLE branch (
  name           TEXT    NOT NULL PRIMARY KEY,
  parent_branch  TEXT,
  fork_seq       INTEGER,
  created_seq    INTEGER NOT NULL,
  head_seq       INTEGER NOT NULL,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  status         TEXT    NOT NULL DEFAULT 'active'
);

CREATE INDEX idx_branch_status ON branch (status);
CREATE INDEX idx_branch_parent ON branch (parent_branch);
```

### 3.6 `invocation` — Reserved Persisted Invocation Payloads

Reserved for a future pass that persists signed write envelopes. Current plain
`/memory/transact` commits do not populate this table.

```sql
CREATE TABLE invocation (
  ref         TEXT    NOT NULL PRIMARY KEY,
  iss         TEXT    NOT NULL,
  aud         TEXT,
  cmd         TEXT    NOT NULL,
  sub         TEXT    NOT NULL,
  invocation  JSON    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_invocation_sub ON invocation (sub);
CREATE INDEX idx_invocation_cmd ON invocation (cmd);
CREATE INDEX idx_invocation_iss ON invocation (iss);
```

Current implementation note:

- existing rows may remain from earlier experimental builds
- treat any stored blob and extracted fields as untrusted audit data, not as
  verified authorization proof

### 3.7 `authorization` — Reserved Persisted Authorization Payloads

Reserved for a future pass that persists signed write envelopes. Current plain
`/memory/transact` commits do not populate this table.

```sql
CREATE TABLE authorization (
  ref            TEXT    NOT NULL PRIMARY KEY,
  authorization  JSON    NOT NULL,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

Current implementation note:

- the authorization blob is persisted verbatim from the current transport
  payload
- verification and binding to the websocket caller remain deferred in this pass
- treat persisted authorization JSON as untrusted audit data until verification
  lands

### 3.8 `blob_store` — Immutable Content-Addressed Binary Data

Stores raw immutable blob payloads.

```sql
CREATE TABLE blob_store (
  hash          TEXT    NOT NULL PRIMARY KEY,
  data          BLOB    NOT NULL,
  content_type  TEXT,
  size          INTEGER NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

### 3.9 `state` — Convenience View

The current visible state of a branch/entity is defined by `head`. A simple
helper view can expose current head pointers:

```sql
CREATE VIEW state AS
SELECT branch, id, seq, op_index
FROM head;
```

Materializing the actual JSON document still requires the read algorithm in
section 5.

## 4. Revision Storage

### 4.1 How Revisions Are Stored

Each accepted transaction produces:

1. one `commit` row
2. one or more `revision` rows
3. one `head` update per touched entity
4. optional `snapshot` refreshes

If a transaction contains:

```typescript
[
  { op: "set", id: "a", value: { value: { count: 1 } } },
  {
    op: "patch",
    id: "b",
    patches: [{ op: "replace", path: "/value/name", value: "x" }],
  },
];
```

then the server appends:

- `commit(seq = N, ...)`
- `revision(branch, "a", N, 0, "set", <document>)`
- `revision(branch, "b", N, 1, "patch", <patches>)`

### 4.2 Write Path

The write path for `/memory/transact` is:

```sql
BEGIN;

INSERT INTO commit (
  seq, branch, session_id, local_seq,
  invocation_ref, authorization_ref,
  original, resolution
)
VALUES (
  :seq, :branch, :session_id, :local_seq,
  NULL, NULL,
  :original_json, :resolution_json
);

INSERT INTO revision (branch, id, seq, op_index, op, data, commit_seq)
VALUES (:branch, :id, :seq, :op_index, :op, :data_json, :seq);

INSERT INTO head (branch, id, seq, op_index)
VALUES (:branch, :id, :seq, :op_index)
ON CONFLICT (branch, id)
DO UPDATE SET seq = excluded.seq, op_index = excluded.op_index;

COMMIT;
```

The same pattern applies to branch lifecycle writes, except those commands do
not append `revision` rows and instead update the `branch` table.

## 5. Read Path

### 5.1 Read Current Value

To read the current value of an entity on a branch:

1. look up `(seq, op_index)` in `head`
2. load the nearest `snapshot` on or before `seq`
3. replay later `revision` rows for that entity through `seq`

```sql
SELECT seq, op_index
FROM head
WHERE branch = :branch AND id = :id;
```

Nearest snapshot:

```sql
SELECT seq, value
FROM snapshot
WHERE branch = :branch
  AND id = :id
  AND seq <= :target_seq
ORDER BY seq DESC
LIMIT 1;
```

Later revisions:

```sql
SELECT seq, op_index, op, data
FROM revision
WHERE branch = :branch
  AND id = :id
  AND seq > :base_seq
  AND seq <= :target_seq
ORDER BY seq ASC, op_index ASC;
```

Replay rules:

- `set`: replace the full document
- `patch`: apply the patch list to the current document
- `delete`: mark the entity deleted

### 5.2 Point-in-Time Read

Point-in-time reads use the same algorithm, but `target_seq` is provided by the
caller rather than coming from `head`.

If no snapshot exists, replay begins from the entity's implicit Empty state.

### 5.3 Read Multiple Entities

For batched reads, implementations SHOULD:

- fetch `head` or point-in-time targets in one query
- fetch snapshots in bulk
- fetch revisions grouped by entity
- reuse parsed JSON where possible

## 6. Snapshot Creation

### 6.1 Trigger Condition

The server SHOULD create or refresh snapshots:

- after a configurable number of revisions on one entity
- when patch replay depth exceeds a configured threshold
- opportunistically during background maintenance

### 6.2 Snapshot Materialization

To materialize a snapshot:

1. reconstruct the entity document at `target_seq`
2. upsert a `snapshot(branch, id, seq, value)` row

```sql
INSERT INTO snapshot (branch, id, seq, value)
VALUES (:branch, :id, :seq, :value_json)
ON CONFLICT (branch, id, seq) DO NOTHING;
```

### 6.3 Snapshot Compaction

The storage layer MAY retain only the newest snapshot per entity per branch, or
retain a short historical tail for faster point-in-time reads.

## 7. Garbage Collection

### 7.1 JSON Revision History

The revision log is append-only and forms the audit trail. Revisions are not
deleted during ordinary GC.

An operator may compact a space's revision history offline with
`cf space compact` ([the compaction plan](../../plans/compact-space.md)). A
compaction keeps every head's `(seq, op_index)` but the ACL document's,
makes each selected instance's oldest kept row its base at the cut (a `patch`
boundary is rewritten as a `set` holding the engine's reconstruction at that
row; a `set` or `delete` boundary keeps its operation, so a deleted document
stays deleted) and attributes that row, whatever its operation, to a
`system`-class compaction commit (session `compaction:<run id>`), deletes
the rows and snapshots behind it, and replaces the payload of every commit
outside a retention window with a marker carrying a hash of what it held;
commit 1, the commits an `op_*` row references, and the compaction commits
themselves keep theirs. Every commit row survives. The compacted range is
readable only from the archive the operator took before the run, and the
engine treats a read basis below an instance's compacted boundary as
unknown rather than as a genuine absence (`03-commit-model.md` §3.6.1's
identity exemption does not apply across it).

### 7.2 Old Snapshots

Snapshots older than the configured retention policy may be deleted.

```sql
DELETE FROM snapshot
WHERE (branch, id, seq) NOT IN (
  SELECT branch, id, MAX(seq)
  FROM snapshot
  GROUP BY branch, id
);
```

### 7.3 Session-Local Replay State

Ephemeral in-memory structures for pending-read resolution and session sync may
be pruned once every connected session has acknowledged a `seenSeq` newer than
the relevant entry.

### 7.4 Policy

- GC runs as a background task, never inside user commits
- default policy is retain-all for revisions
- snapshots and in-memory session state are the primary GC targets in phase 1

## 8. Branch Storage

### 8.1 Branch Representation

Branches share the same `revision` and `commit` logs but maintain separate head
pointers in `head`.

Branch creation appends a write-class `commit` row and inserts branch metadata:

```sql
INSERT INTO branch (name, parent_branch, fork_seq, created_seq, head_seq)
VALUES (:name, :parent_branch, :fork_seq, :created_seq, :created_seq);
```

### 8.2 Branch Writes

Writing to a branch is identical to writing to the default branch, except the
`branch` column on `commit`, `revision`, `head`, and `snapshot` rows is set to
that branch name.

### 8.3 Branch Seq Numbering

Seq is space-global across all branches. `created_seq` records when the branch
name came into existence. `head_seq` records the newest entity-state change
visible on that branch.

### 8.4 Branch Deletion

Branch deletion appends a write-class `commit` row and marks the branch as
deleted:

```sql
UPDATE branch
SET status = 'deleted'
WHERE name = :name;
```

Branch deletion does not remove shared revision history.

## 9. Point-in-Time Read Implementation

### 9.1 Algorithm

For entity `(branch, id)` at `target_seq`:

1. resolve the visible branch-local head at or before `target_seq`
2. locate the nearest snapshot at or before `target_seq`
3. replay later revisions up to `target_seq`
4. return the resulting document or tombstone

### 9.2 Branch-Aware PIT Reads

If an entity has no explicit head on a child branch, head resolution falls back
through the parent branch chain at the child's `fork_seq`.

## 10. Blob Store Operations

### 10.1 Write a Blob

```sql
INSERT OR IGNORE INTO blob_store (hash, data, content_type, size)
VALUES (:hash, :data, :content_type, :size);
```

### 10.2 Read a Blob

```sql
SELECT data, content_type, size
FROM blob_store
WHERE hash = :hash;
```

### 10.3 Blob Metadata

Blob metadata remains ordinary entity state under:

```text
urn:blob-meta:<blob_hash>
```

The blob payload is content-addressed. The metadata entity participates in the
normal seq-based JSON revision model.

## 11. Migration

This design is intentionally a clean break:

- the content-addressed JSON `value` table is removed
- the content-addressed JSON `fact` table is removed
- `commit.hash` is removed from the semantic JSON write path
- current JSON state is reconstructed from `snapshot + revision replay`

Because patches, snapshots, branches, resumable sessions, and session-scoped
catch-up sync all change meaning together, in-place migration from the older
hash-oriented schema is not a design goal for phase 1.
