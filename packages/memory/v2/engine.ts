import { Database } from "@db/sqlite";
import type { FabricValue, JSONSchema } from "@commonfabric/api";
import {
  hashStringOf,
  taggedHashStringOf,
  valueEqual,
} from "@commonfabric/data-model";
import { walkSchemaDocumentClosure } from "@commonfabric/data-model-schema/schema-closure";
import { isSubschema } from "@commonfabric/data-model-schema/schema-walk";
import {
  classifySchemaMeta,
  collectExternalSchemaRefHashes,
  SCHEMA_META_MEMBER,
  schemaMetaRefHashes,
} from "@commonfabric/data-model-schema/schema-refs";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import { mapLinkSchemas } from "./schema-table-links.ts";
import {
  applySqliteCommitWrite,
  RowLabelCommitError,
} from "./sqlite/commit-eval.ts";
export { RowLabelCommitError } from "./sqlite/commit-eval.ts";
import {
  applyPatchToDocument,
  emptyEntityDocument,
  PatchApplyError,
  patchOpChangesParentKeySet,
  touchedPointerPaths,
} from "./patch.ts";
import {
  encodePointer,
  isPrefixPath,
  parentPath,
  parsePointer,
  pathsOverlap,
} from "./path.ts";
import { replaceSchedulerBasisRows } from "./scheduler-basis.ts";
import {
  insertExecutionOutboxRows,
  type OutboxAppendRow,
} from "./execution-outbox.ts";
import {
  createDefaultOperationCodecRegistry,
  operationBaselineHash,
  type OperationCodecRegistry,
} from "./operation-codec.ts";
import {
  containsReservedSchemaRefSubstring,
  containsSyncSchemaRefString,
  findSyncSchemaRef,
} from "./sync-schema-ref.ts";
import {
  type ApplyOpOperation,
  type ApplyOpResolution,
  type BranchName,
  type CellScope,
  type ClientCommit,
  type CommitClass,
  commitPreconditionValueHash,
  decodeMemoryBoundary,
  decodeStoredDocumentPayload,
  decodeStoredPatchListPayload,
  DEFAULT_BRANCH,
  type DeleteOperation,
  type DerivedWriteAnnotation,
  type EffectIntentEntry,
  encodeMemoryBoundary,
  type EntityDocument,
  type EntityId,
  type EventAppendDecl,
  EventAppendDuplicateError,
  getServerExecutionConfig,
  type IntegratedOperation,
  isEntityDocument,
  isScopeKey,
  type OpCursor,
  type Operation,
  type OperationFieldQuery,
  type OperationFieldSnapshot,
  type PatchOp,
  type PatchOperation,
  ProtocolError,
  type Reference,
  type ReleaseOpFieldOperation,
  resolvePrincipalSessionKey,
  resolveScopeKey,
  type ScopeKey,
  scopeOfScopeKey,
  SERVER_EXECUTION_ATTENTION_DOC_ID,
  SERVER_EXECUTION_EFFECTS_DOC_ID,
  type SessionEffectsDocValue,
  type SessionId,
  type SetOperation,
  type SqliteOperation,
  STREAM_ENTRIES_DOC_PREFIX,
  streamEntriesDocId,
  type StreamEventEntry,
  type StreamEventFiredAt,
  type StreamEventsDocValue,
  type StreamLinkRef,
  tableDeclaresRowLabel,
  type ValuePath,
} from "../v2.ts";

// The scope_key vocabulary is PROTOCOL vocabulary and lives in the
// wire-shape module (../v2.ts, beside CellScope) as the ONE definition —
// ledger LD3 (key-vocabulary.md §3). The engine imports it and re-exports
// the names its consumers historically reached through `Engine.*`; it
// defines no scope-key format of its own. Identity DERIVATION stays
// engine-owned: admission threads the authenticated session's
// principal/sessionId into the constructor for `authored` traffic.
export {
  principalOfSessionKey,
  ProtocolError,
  resolveScopeKey,
} from "../v2.ts";

const DEFAULT_SCOPE: CellScope = "space";
// The space scope's one shared instance, per the shared vocabulary (the
// `scope ?? "space"` construction below and every stored default agree).
const DEFAULT_SCOPE_KEY: ScopeKey = "space";
const normalizeScope = (scope: CellScope | undefined): CellScope =>
  scope ?? DEFAULT_SCOPE;

const integratedOperationId = (
  address: {
    branch: BranchName;
    id: EntityId;
    scopeKey: string;
    path: readonly string[];
  },
  epoch: number,
  version: number,
): string =>
  `op:${
    hashStringOf(encodeMemoryBoundary({
      branch: address.branch,
      id: address.id,
      scopeKey: address.scopeKey,
      path: [...address.path],
      epoch,
      version,
    }))
  }`;

const sameEventEntryExceptResolution = (
  left: StreamEventEntry,
  right: StreamEventEntry,
): boolean => {
  const { resolution: _leftResolution, ...leftRest } = left;
  const { resolution: _rightResolution, ...rightRest } = right;
  return valueEqual(leftRest as FabricValue, rightRest as FabricValue);
};

const isEventAttentionResolution = (
  value: StreamEventEntry["resolution"],
): boolean =>
  value?.kind === "dismissed" ||
  (value?.kind === "retried" && typeof value.eventId === "string" &&
    value.eventId !== "");

export const resolveCommitSessionKey = (
  sessionId: SessionId,
  principal?: string,
): string =>
  principal ? resolvePrincipalSessionKey(principal, sessionId) : sessionId;

const PRAGMAS = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA cache_size = -64000;
  PRAGMA temp_store = MEMORY;
  PRAGMA mmap_size = 268435456;
  PRAGMA foreign_keys = ON;
`;

const NEW_DB_PRAGMAS = `
  PRAGMA page_size = 32768;
`;

const INIT = `
BEGIN TRANSACTION;

CREATE TABLE IF NOT EXISTS authorization (
  ref            TEXT    NOT NULL PRIMARY KEY,
  authorization  JSON    NOT NULL,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invocation (
  ref         TEXT    NOT NULL PRIMARY KEY,
  iss         TEXT    NOT NULL,
  aud         TEXT,
  cmd         TEXT    NOT NULL,
  sub         TEXT    NOT NULL,
  invocation  JSON    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invocation_sub ON invocation (sub);
CREATE INDEX IF NOT EXISTS idx_invocation_cmd ON invocation (cmd);
CREATE INDEX IF NOT EXISTS idx_invocation_iss ON invocation (iss);

CREATE TABLE IF NOT EXISTS "commit" (
  seq                INTEGER NOT NULL PRIMARY KEY,
  branch             TEXT    NOT NULL DEFAULT '',
  session_id         TEXT    NOT NULL,
  local_seq          INTEGER NOT NULL,
  invocation_ref     TEXT,
  authorization_ref  TEXT,
  original           JSON    NOT NULL,
  resolution         JSON    NOT NULL,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  -- Server-execution v2 commit class: 'authored' | 'derived' | 'system', a
  -- closed set (docs/specs/server-side-execution/protocol.md §1). Determined
  -- by the admission path that processed the commit, never client-supplied.
  -- Written in every flag arm; enforced only under
  -- EXPERIMENTAL_SERVER_EXECUTION. Kept last so migrated stores and fresh
  -- stores agree on column order.
  class              TEXT    NOT NULL DEFAULT 'authored',
  -- The producing lease holder, derived-class commits only (protocol.md §7's
  -- closed metadata list: 'holder' — derived only). NULL on every other
  -- class. Admission verified it against the live execution_lease row before
  -- the insert (serving-loop.md §2), so a stored value names the holder that
  -- actually held the lease at admission time.
  holder             TEXT,
  -- Per-write identity annotations WITHIN a derived commit's body
  -- (protocol.md §1: the addressing/attribution pair, per action run) and
  -- the eventIds the commit consequences (protocol.md §7: consequenceOf,
  -- derived only — bounded by the wave's input, never graph-scaled). JSON
  -- arrays; NULL on every non-derived class. Attribution is recorded, not
  -- read (protocol.md §1); the scopeKey half was CONSUMED at admission to
  -- key scoped rows.
  annotations        JSON,
  consequence_of     JSON,
  -- The watermark this derived commit is current through (protocol.md §4,
  -- §7's closed metadata list: 'derivedThrough' — derived only). NULL on
  -- every other class, and NULL on derived commits produced outside a
  -- serving loop (stage-D-era test waves predate the watermark). The
  -- watermark DOC (one well-known doc per space) rides the commit's own
  -- operations; this column is the metadata half.
  derived_through    INTEGER,
  -- Server-produced AUTHORED commits only (protocol.md §2's delegated
  -- row, §2b): the ORIGINATING chain actor + the capability grant this
  -- commit was admitted under — delegation, never session-identity
  -- impersonation. NULL on every other admission path.
  acting_principal   TEXT,
  acting_session     TEXT,
  capability_ref     TEXT,
  FOREIGN KEY (invocation_ref) REFERENCES invocation(ref),
  FOREIGN KEY (authorization_ref) REFERENCES authorization(ref)
);
CREATE INDEX IF NOT EXISTS idx_commit_branch ON "commit" (branch);
CREATE UNIQUE INDEX IF NOT EXISTS idx_commit_session_local_seq
  ON "commit" (session_id, local_seq);
CREATE INDEX IF NOT EXISTS idx_commit_invocation_ref
  ON "commit" (invocation_ref);

CREATE TABLE IF NOT EXISTS revision (
  branch      TEXT    NOT NULL DEFAULT '',
  id          TEXT    NOT NULL,
  scope_key   TEXT    NOT NULL DEFAULT 'space',
  seq         INTEGER NOT NULL,
  op_index    INTEGER NOT NULL,
  op          TEXT    NOT NULL,
  data        JSON,
  commit_seq  INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index),
  FOREIGN KEY (commit_seq) REFERENCES "commit"(seq)
);
CREATE INDEX IF NOT EXISTS idx_revision_branch_id_seq
  ON revision (branch, id, scope_key, seq, op_index);
CREATE INDEX IF NOT EXISTS idx_revision_commit
  ON revision (commit_seq);
CREATE INDEX IF NOT EXISTS idx_revision_branch
  ON revision (branch, seq);

CREATE TABLE IF NOT EXISTS head (
  branch    TEXT    NOT NULL,
  id        TEXT    NOT NULL,
  scope_key TEXT    NOT NULL DEFAULT 'space',
  seq       INTEGER NOT NULL,
  op_index  INTEGER NOT NULL,
  op        TEXT    NOT NULL CHECK (op IN ('set', 'patch', 'delete')),
  PRIMARY KEY (branch, id, scope_key)
);
CREATE INDEX IF NOT EXISTS idx_head_branch ON head (branch);

CREATE TABLE IF NOT EXISTS snapshot (
  branch  TEXT    NOT NULL DEFAULT '',
  id      TEXT    NOT NULL,
  scope_key TEXT  NOT NULL DEFAULT 'space',
  seq     INTEGER NOT NULL,
  value   JSON    NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq)
);
CREATE INDEX IF NOT EXISTS idx_snapshot_lookup ON snapshot (branch, id, scope_key, seq);

CREATE TABLE IF NOT EXISTS op_field_epoch (
  branch         TEXT    NOT NULL DEFAULT '',
  id             TEXT    NOT NULL,
  scope_key      TEXT    NOT NULL DEFAULT 'space',
  path           JSON    NOT NULL,
  epoch          INTEGER NOT NULL,
  codec          TEXT    NOT NULL,
  version        INTEGER NOT NULL,
  baseline_hash  TEXT    NOT NULL,
  materialized   JSON    NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,
  commit_seq     INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, path)
);

CREATE TABLE IF NOT EXISTS op_submission (
  branch              TEXT    NOT NULL DEFAULT '',
  id                  TEXT    NOT NULL,
  scope_key           TEXT    NOT NULL DEFAULT 'space',
  path                JSON    NOT NULL,
  epoch               INTEGER NOT NULL,
  submission_id       TEXT    NOT NULL,
  codec               TEXT    NOT NULL,
  base_version        INTEGER NOT NULL,
  submitted_payload   JSON    NOT NULL,
  integrated_from     INTEGER NOT NULL,
  integrated_to       INTEGER NOT NULL,
  integrated_payload  JSON    NOT NULL,
  commit_seq          INTEGER NOT NULL,
  op_index            INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, path, epoch, submission_id),
  FOREIGN KEY (commit_seq) REFERENCES "commit"(seq)
);
CREATE INDEX IF NOT EXISTS idx_op_submission_commit
  ON op_submission (commit_seq, op_index);

CREATE TABLE IF NOT EXISTS op_integrated (
  branch         TEXT    NOT NULL DEFAULT '',
  id             TEXT    NOT NULL,
  scope_key      TEXT    NOT NULL DEFAULT 'space',
  path           JSON    NOT NULL,
  epoch          INTEGER NOT NULL,
  version        INTEGER NOT NULL,
  op_id          TEXT    NOT NULL UNIQUE,
  submission_id  TEXT    NOT NULL,
  payload        JSON    NOT NULL,
  commit_seq     INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, path, epoch, version),
  FOREIGN KEY (commit_seq) REFERENCES "commit"(seq)
);

CREATE TABLE IF NOT EXISTS op_checkpoint (
  branch        TEXT    NOT NULL DEFAULT '',
  id            TEXT    NOT NULL,
  scope_key     TEXT    NOT NULL DEFAULT 'space',
  path          JSON    NOT NULL,
  epoch         INTEGER NOT NULL,
  version       INTEGER NOT NULL,
  materialized  JSON    NOT NULL,
  commit_seq    INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, path, epoch, version),
  FOREIGN KEY (commit_seq) REFERENCES "commit"(seq)
);

CREATE TABLE IF NOT EXISTS branch (
  name           TEXT    NOT NULL PRIMARY KEY,
  parent_branch  TEXT,
  fork_seq       INTEGER,
  created_seq    INTEGER NOT NULL DEFAULT 0,
  head_seq       INTEGER NOT NULL DEFAULT 0,
  status         TEXT    NOT NULL DEFAULT 'active',
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  deleted_at     TEXT,
  FOREIGN KEY (parent_branch) REFERENCES branch(name)
);
INSERT OR IGNORE INTO branch (name, created_seq, head_seq, status)
VALUES ('', 0, 0, 'active');

-- Server-execution v2: the single-deriver lease
-- (docs/specs/server-side-execution/serving-loop.md §2). One row per space,
-- EXACTLY three fields — the v1 branch's richer shape (branch PK,
-- generation/host/on-behalf-of columns, a state enum) is prior art this
-- REDUCES from, not substrate. 'holder' is a per-process identity (service
-- identity + process-instance component, minted at process start — DR1), so
-- the admission equality check itself fences cross-process succession.
-- Acquire/renew are DIRECT table writes on the direct-engine plane
-- (serving-loop.md §1 plane (c)) — a lease renewal is never a commit.
-- Liveness is judged by the memory server's own clock against expires_at;
-- an expired row matches nobody. References nothing; nothing references it.
CREATE TABLE IF NOT EXISTS execution_lease (
  space       TEXT    NOT NULL PRIMARY KEY,
  holder      TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL
);

-- Server-execution v2: the scheduler basis index
-- (docs/specs/server-side-execution/serving-loop.md §3b) — "output current
-- iff these inputs unchanged since these seqs". Ids + seqs ONLY, overwritten
-- in place per (action, action_scope_key); never payloads, never per-run
-- history (payloads or per-run history are the evidence log, FORBIDDEN).
-- Rows are written INSIDE a wave's derived store transaction — never own
-- commits, never pushed to subscribers, never read at admission. Recovery
-- and warm start are the same move: activation re-marks the dirty frontier
-- by comparing recorded input seqs against current heads. The table starts
-- EMPTY: nothing is backfilled from the dropped observation tables (D10).
-- The writer is scheduler-basis.ts (stage D), invoked inside a wave's
-- derived store transaction; nothing invokes it in production until the
-- serving loop lands (plan Phase 1 stages E-F).
-- One standalone table. No FOREIGN KEY clauses anywhere: v1's satellites
-- all hung off scheduler_observation; the v2 index references nothing and
-- nothing references it.
CREATE TABLE IF NOT EXISTS scheduler_basis (
  branch           TEXT    NOT NULL, -- engine-v3 branch, as on every table
  action           TEXT    NOT NULL, -- durable action identity/fingerprint;
                                     --   restart-stable (a per-process
                                     --   component would empty the index
                                     --   exactly when recovery reads it)
  action_scope_key TEXT    NOT NULL, -- the INSTANCE that ran (scopes.md §7
                                     --   M2 re-keying; scope_key vocabulary
                                     --   is today's resolveScopeKey, moving
                                     --   to the wire-shape module per LD3,
                                     --   key-vocabulary.md §3)
  entity_space     TEXT    NOT NULL, -- the input doc's space: foreign reads
                                     --   are logged reads too
                                     --   (serving-loop.md §3b cross-space)
  entity           TEXT    NOT NULL, -- the input doc id
  entity_scope_key TEXT    NOT NULL, -- the input INSTANCE read
  seq              INTEGER NOT NULL, -- the input's seq at read time, in the
                                     --   entity's own space's sequence;
                                     --   in-wave reads share the wave's
                                     --   commit seq
  PRIMARY KEY (branch, action, action_scope_key,
               entity_space, entity, entity_scope_key)
);
-- Entity-keyed lookup mirror (implementation detail per serving-loop.md
-- §3b): activation's re-mark scan resolves "who read this doc" without a
-- full-table walk, the successor of idx_scheduler_read_index_lookup.
CREATE INDEX IF NOT EXISTS idx_scheduler_basis_entity
  ON scheduler_basis (branch, entity_space, entity, entity_scope_key);

-- Server-execution v2: the DURABLE half of the outbox
-- (docs/specs/server-side-execution/serving-loop.md §5, FP1 RULED
-- 2026-08-03) — pending cross-space event appends. Rows are written
-- INSIDE the emitting wave's own store transaction (applyWaveCommit;
-- the basis-row carriage pattern, protocol.md §7) and DELETED on
-- delivery-ack: a queue that empties, never history. A row carries the
-- event (payload bounded by the event, never graph-scaled) plus the
-- ORIGINATING chain actor + capabilityRef the target's admission
-- validates and stamps firedAt from (events.md §2; protocol.md §2's
-- server-produced authored row). Never wire, never commit metadata,
-- never read at admission. The EFFECT half of the outbox is
-- process-local by design and has NO table (serving-loop.md §4's
-- FORBIDDEN "pending effects" table — crash recovery re-misses effects
-- from memo keys). References nothing; nothing references it. The
-- writer/reader module is execution-outbox.ts.
CREATE TABLE IF NOT EXISTS execution_outbox (
  id                INTEGER PRIMARY KEY, -- declared alias of rowid: the
                                      --   delivery-ack handle. Declared so
                                      --   it is STABLE across VACUUM —
                                      --   an implicit rowid can be
                                      --   renumbered by maintenance,
                                      --   letting an ack delete the
                                      --   wrong row (a lost append).
  branch            TEXT    NOT NULL,
  target_space      TEXT    NOT NULL,
  target_stream     TEXT    NOT NULL, -- the target stream SIDECAR doc id
  target_stream_link TEXT,            -- the stream link {id, path, scope?}
                                      --   (JSON) — the delivered entry's
                                      --   self-describing stream field
                                      --   (Phase 3; events §1)
  event_id          TEXT    NOT NULL, -- durable id; the target's dedupe
                                      --   horizon keys on it (events §4)
  payload           TEXT    NOT NULL, -- the event payload, JSON —
                                      --   bounded by the event
  acting_principal  TEXT,             -- the originating chain actor
  acting_session    TEXT,             --   (absent for sessionless chains)
  sessionless_space_scope INTEGER,    -- the OW15 declaration (protocol §2's
                                      --   Phase-3 floor carve-out): 1 iff
                                      --   the chain has NO actor and the
                                      --   entry stamps firedAt
                                      --   {session:"server"}; grant stays
                                      --   mandatory
  capability_ref    TEXT    NOT NULL, -- validated at the target
  created_seq       INTEGER NOT NULL  -- the emitting wave's commit seq
);
CREATE INDEX IF NOT EXISTS idx_execution_outbox_branch
  ON execution_outbox (branch);

CREATE TABLE IF NOT EXISTS blob_store (
  hash          TEXT    NOT NULL PRIMARY KEY,
  data          BLOB    NOT NULL,
  content_type  TEXT    NOT NULL,
  size          INTEGER NOT NULL
);

COMMIT;
`;

const INSERT_AUTHORIZATION = `
INSERT OR IGNORE INTO authorization (ref, authorization)
VALUES (:ref, :authorization)
`;

const INSERT_INVOCATION = `
INSERT OR IGNORE INTO invocation (ref, iss, aud, cmd, sub, invocation)
VALUES (:ref, :iss, :aud, :cmd, :sub, :invocation)
`;

const INSERT_COMMIT = `
INSERT INTO "commit" (
  seq,
  branch,
  session_id,
  local_seq,
  invocation_ref,
  authorization_ref,
  original,
  resolution,
  class,
  holder,
  annotations,
  consequence_of,
  derived_through,
  acting_principal,
  acting_session,
  capability_ref
)
VALUES (
  :seq,
  :branch,
  :session_id,
  :local_seq,
  :invocation_ref,
  :authorization_ref,
  :original,
  :resolution,
  :class,
  :holder,
  :annotations,
  :consequence_of,
  :derived_through,
  :acting_principal,
  :acting_session,
  :capability_ref
)
`;

const UPDATE_COMMIT_RESOLUTION = `
UPDATE "commit"
SET resolution = :resolution
WHERE seq = :seq
`;

const INSERT_REVISION = `
INSERT INTO revision (
  branch,
  id,
  scope_key,
  seq,
  op_index,
  op,
  data,
  commit_seq
)
VALUES (
  :branch,
  :id,
  :scope_key,
  :seq,
  :op_index,
  :op,
  :data,
  :commit_seq
)
`;

const UPSERT_HEAD = `
INSERT INTO head (branch, id, scope_key, seq, op_index, op)
VALUES (:branch, :id, :scope_key, :seq, :op_index, :op)
ON CONFLICT (branch, id, scope_key) DO UPDATE
SET seq = :seq, op_index = :op_index, op = :op
`;

const INSERT_SNAPSHOT = `
INSERT OR REPLACE INTO snapshot (branch, id, scope_key, seq, value)
VALUES (:branch, :id, :scope_key, :seq, :value)
`;

const DELETE_OLD_SNAPSHOTS = `
DELETE FROM snapshot
WHERE branch = :branch
  AND id = :id
  AND scope_key = :scope_key
  AND seq NOT IN (
    SELECT seq
    FROM snapshot
    WHERE branch = :branch
      AND id = :id
      AND scope_key = :scope_key
    ORDER BY seq DESC
    LIMIT :retention
  )
`;

const UPDATE_BRANCH_HEAD = `
UPDATE branch
SET head_seq = CASE
  WHEN head_seq < :seq THEN :seq
  ELSE head_seq
END
WHERE name = :branch
`;

const SELECT_HEAD = `
SELECT seq, op_index
FROM head
WHERE branch = :branch AND id = :id AND scope_key = :scope_key
`;

const SELECT_CURRENT_LOCAL = `
SELECT r.seq, r.op_index, r.op, r.data
FROM head h
JOIN revision r
 ON r.branch = h.branch
 AND r.id = h.id
 AND r.scope_key = h.scope_key
 AND r.seq = h.seq
 AND r.op_index = h.op_index
WHERE h.branch = :branch AND h.id = :id AND h.scope_key = :scope_key
`;

const SELECT_CURRENT_ENTITY_IDS = `
SELECT id
FROM head
WHERE branch = :branch
  AND scope_key = :scope_key
  AND op <> 'delete'
ORDER BY id ASC
`;

const SELECT_CURRENT_ENTITY_ID_PAGE = `
SELECT id
FROM head
WHERE branch = :branch
  AND scope_key = :scope_key
  AND op <> 'delete'
ORDER BY id ASC
LIMIT :limit
`;

const SELECT_CURRENT_ENTITY_ID_PAGE_AFTER = `
SELECT id
FROM head
WHERE branch = :branch
  AND scope_key = :scope_key
  AND op <> 'delete'
  AND id > :after
ORDER BY id ASC
LIMIT :limit
`;

const SELECT_CURRENT_ENTITY_ID = `
SELECT 1 AS present
FROM head
WHERE branch = :branch
  AND scope_key = :scope_key
  AND id = :id
  AND op <> 'delete'
LIMIT 1
`;

const SELECT_AT_SEQ_LOCAL = `
SELECT seq, op_index, op, data
FROM revision
WHERE branch = :branch
  AND id = :id
  AND scope_key = :scope_key
  AND seq <= :seq
ORDER BY seq DESC, op_index DESC
LIMIT 1
`;

const SELECT_LATEST_BASE = `
SELECT seq, op_index, op, data
FROM revision
WHERE branch = :branch
  AND id = :id
  AND scope_key = :scope_key
  AND op IN ('set', 'delete')
  AND (
    seq < :seq OR
    (seq = :seq AND op_index <= :op_index)
  )
ORDER BY seq DESC, op_index DESC
LIMIT 1
`;

const SELECT_LATEST_SNAPSHOT = `
SELECT seq, value
FROM snapshot
WHERE branch = :branch
  AND id = :id
  AND scope_key = :scope_key
  AND seq <= :seq
ORDER BY seq DESC
LIMIT 1
`;

const SELECT_PATCHES = `
SELECT seq, op_index, data
FROM revision
WHERE branch = :branch
  AND id = :id
  AND scope_key = :scope_key
  AND op = 'patch'
  AND (
    seq > :base_seq OR
    (seq = :base_seq AND op_index > :base_op_index)
  )
  AND (
    seq < :seq OR
    (seq = :seq AND op_index <= :op_index)
  )
ORDER BY seq ASC, op_index ASC
`;

const SELECT_PATCH_COUNT = `
SELECT COUNT(*) AS count
FROM revision
WHERE branch = :branch
  AND id = :id
  AND scope_key = :scope_key
  AND op = 'patch'
  AND seq > :after_seq
  AND seq <= :seq
`;

const SELECT_NEXT_SEQ = `
SELECT COALESCE(MAX(seq), 0) + 1 AS seq
FROM "commit"
`;

const SELECT_SERVER_SEQ = `
SELECT COALESCE(MAX(seq), 0) AS seq
FROM "commit"
`;

const SELECT_EXISTING_COMMIT = `
SELECT seq, branch, original, resolution, class, holder
FROM "commit"
WHERE session_id = :session_id
  AND local_seq = :local_seq
`;

// The derived-class admission read (serving-loop.md §2): the space's LIVE
// lease row, liveness judged by the memory server's own clock (the :now the
// admission path passes is always this process's Date.now()). An expired row
// is not returned, so it matches nobody.
const SELECT_LIVE_EXECUTION_LEASE = `
SELECT holder
FROM execution_lease
WHERE space = :space
  AND expires_at > :now
`;

const SELECT_SET_DELETE_CONFLICT = `
SELECT seq
FROM revision
WHERE branch = :branch
  AND id = :id
  AND scope_key = :scope_key
  AND seq > :after_seq
  AND op IN ('set', 'delete')
ORDER BY seq DESC, op_index DESC
LIMIT 1
`;

const SELECT_PATCH_CONFLICTS = `
SELECT seq, op_index, data
FROM revision
WHERE branch = :branch
  AND id = :id
  AND scope_key = :scope_key
  AND seq > :after_seq
  AND op = 'patch'
ORDER BY seq DESC, op_index DESC
`;

const SELECT_PENDING_RESOLUTION = `
SELECT seq
FROM "commit"
WHERE session_id = :session_id
  AND local_seq = :local_seq
`;

// True-basis (CT-1910) variants of the conflict scans: identical intervals,
// but writes produced by the layers the read NAMES (`local_seq` in the
// read's declared dependency array, same session) are excluded — the
// accepted own layers the reader's materialized view included; conflicting
// with them would be the self-conflict that forced pending reads to
// over-advance their basis in the first place. The exclusion is the
// DECLARED SET, not a predecessor mask (`local_seq <` the reader's): the
// declared array is the reader's claim of exactly which own layers its
// view sat on, so an own write the array does NOT name conflicts like a
// foreign write whatever its localSeq. That covers both an own write with
// a HIGHER localSeq accepted first (out-of-order submission — e.g. the
// runner's hold-mode admission can release a later blind commit while an
// earlier read-bearing commit waits) and an own PREDECESSOR the client
// omitted while its write is durable — a buggy or selectively-excluding
// client whose view is missing integrated state (the missed-write
// direction of INV-1). The declared shape thus validates itself:
// basisSeq plus the named layers must fully account for the doc's durable
// history at the read path, and the server checks that rather than
// trusting client discipline.
const SELECT_SET_DELETE_CONFLICT_EXCLUDING_SESSION = `
SELECT r.seq AS seq
FROM revision r
JOIN "commit" c ON c.seq = r.commit_seq
WHERE r.branch = :branch
  AND r.id = :id
  AND r.scope_key = :scope_key
  AND r.seq > :after_seq
  AND r.op IN ('set', 'delete')
  AND (c.session_id <> :exclude_session
       OR c.local_seq NOT IN (SELECT value FROM json_each(:named_local_seqs)))
ORDER BY r.seq DESC, r.op_index DESC
LIMIT 1
`;

const SELECT_PATCH_CONFLICTS_EXCLUDING_SESSION = `
SELECT r.seq AS seq, r.op_index AS op_index, r.data AS data
FROM revision r
JOIN "commit" c ON c.seq = r.commit_seq
WHERE r.branch = :branch
  AND r.id = :id
  AND r.scope_key = :scope_key
  AND r.seq > :after_seq
  AND r.op = 'patch'
  AND (c.session_id <> :exclude_session
       OR c.local_seq NOT IN (SELECT value FROM json_each(:named_local_seqs)))
ORDER BY r.seq DESC, r.op_index DESC
`;

const SELECT_COMMIT_REVISIONS = `
SELECT branch, id, scope_key, seq, op_index, op, data, commit_seq
FROM revision
WHERE commit_seq = :commit_seq
ORDER BY op_index ASC
`;

const SELECT_BRANCH = `
SELECT name, parent_branch, fork_seq, created_seq, head_seq, status
FROM branch
WHERE name = :branch
`;

const SELECT_BRANCHES = `
SELECT name, parent_branch, fork_seq, created_seq, head_seq, status
FROM branch
ORDER BY name ASC
`;

const INSERT_BRANCH = `
INSERT INTO branch (
  name,
  parent_branch,
  fork_seq,
  created_seq,
  head_seq,
  status
)
VALUES (
  :name,
  :parent_branch,
  :fork_seq,
  :created_seq,
  :head_seq,
  'active'
)
`;

const DELETE_BRANCH = `
UPDATE branch
SET status = 'deleted',
    deleted_at = datetime('now')
WHERE name = :branch
  AND name <> ''
`;

const INSERT_BLOB = `
INSERT OR IGNORE INTO blob_store (hash, data, content_type, size)
VALUES (:hash, :data, :content_type, :size)
`;

const SELECT_BLOB = `
SELECT data, content_type, size
FROM blob_store
WHERE hash = :hash
`;

type PreparedStatement = ReturnType<Database["prepare"]>;

interface PreparedStatements {
  insertAuthorization: PreparedStatement;
  insertBlob: PreparedStatement;
  insertBranch: PreparedStatement;
  insertCommit: PreparedStatement;
  insertInvocation: PreparedStatement;
  insertRevision: PreparedStatement;
  insertSnapshot: PreparedStatement;
  selectAtSeqLocal: PreparedStatement;
  selectBlob: PreparedStatement;
  selectBranch: PreparedStatement;
  selectBranches: PreparedStatement;
  selectCommitRevisions: PreparedStatement;
  selectCurrentLocal: PreparedStatement;
  selectCurrentEntityId: PreparedStatement;
  selectCurrentEntityIds: PreparedStatement;
  selectCurrentEntityIdPage: PreparedStatement;
  selectCurrentEntityIdPageAfter: PreparedStatement;
  selectExistingCommit: PreparedStatement;
  selectHead: PreparedStatement;
  selectLatestBase: PreparedStatement;
  selectLatestSnapshot: PreparedStatement;
  selectLiveExecutionLease: PreparedStatement;
  selectNextSeq: PreparedStatement;
  selectPatchConflicts: PreparedStatement;
  selectPatchConflictsExcludingSession: PreparedStatement;
  selectPatchCount: PreparedStatement;
  selectPatches: PreparedStatement;
  selectPendingResolution: PreparedStatement;
  selectServerSeq: PreparedStatement;
  selectSetDeleteConflict: PreparedStatement;
  selectSetDeleteConflictExcludingSession: PreparedStatement;
  upsertHead: PreparedStatement;
  updateCommitResolution: PreparedStatement;
  updateBranchHead: PreparedStatement;
  deleteBranch: PreparedStatement;
  deleteOldSnapshots: PreparedStatement;
}

/** A decoded revision the engine keeps, with the encoded size it stands in
 * for in the cache's byte budget. */
export type DocumentCacheEntry = {
  document: EntityDocument | null;

  /** The entry's weight against the byte budget, in encoded UTF-8 bytes —
   * a proxy for the decoded graph it keeps alive. For a `set` that is the
   * stored row's data; for a reconstruction it is the resulting document
   * as it would be stored: what the entry retains, not the rows replayed
   * to produce it. */
  weight: number;
};

/** One engine's lifetime counters: the document cache's own events, and the
 * replay a rebuild pays where the cache did not shorten it. */
export type DocumentCacheStats = {
  /** Reads served from the cache. A read that resolved to a stored revision
   * lands in this or in `misses`. A read of an entity that has no revision
   * at all moves neither. */
  hits: number;

  misses: number;
  evictions: number;

  /** Rebuilds that started from a revision the cache still held, replaying
   * only the rows after it rather than the chain since the base or snapshot.
   * The lookup that finds that revision is not a read, so it moves this
   * rather than `hits`. Against `patchReplays` it separates how many
   * rebuilds resumed from how far back they had to start. */
  resumes: number;

  /** Stored patch rows replayed to rebuild a patched document, each row
   * counted once whatever the length of the patch list it holds. A rebuild
   * starts at the newest of the document's base, its newest snapshot, and
   * the newest revision after those that the cache still holds, and replays
   * the rows after that, so what this counts is how far back the rebuild had
   * to start.
   *
   * Every rebuild counts, whichever of the two callers asked for it: a read
   * the cache did not serve, and the commit-time check that the pre-state a
   * patch lands on carries no reserved schema reference. The second reads
   * only in a space whose commits or stored rows carry such a reference, and
   * resumes from the same cache, so it is replay work of the same kind rather
   * than a separate population. */
  patchReplays: number;
};

/** A peek at one engine's document cache. */
export type DocumentCacheDiagnostics = DocumentCacheStats & {
  entries: number;
  bytes: number;
  budgetBytes: number;
  maxEntries: number;
};

export type Engine = {
  url: URL;
  database: Database;
  snapshotInterval: number;
  snapshotRetention: number;
  operationCheckpointInterval: number;
  legacyCommitMetadataRefsRequired: boolean;
  operationCodecs: OperationCodecRegistry;
  statements: PreparedStatements;

  /**
   * Documents already decoded, by the revision each one is.
   *
   * The revision table is only ever appended to, and the snapshots that get
   * pruned are derived from it rather than authoritative, so the document a
   * revision decodes to does not change while the process runs. That is what
   * makes an entry servable without asking whether anything has happened
   * since. It is a property of how the engine writes rather than a rule the
   * engine enforces, which is why the key carries the stored row's shape as
   * well as its address — see {@link documentCacheKey}.
   *
   * What it removes is re-decoding. A read reaches a revision by identity and
   * would otherwise parse its stored text and deep-freeze the result every
   * time, and a runtime reads the same revision far more often than it writes
   * a new one. Reconstructed documents go in too, which is the larger saving:
   * a patched revision costs a base document plus every patch over it.
   *
   * Insertion order is the eviction order: a lookup that finds an entry
   * re-inserts it, so the least
   * recently read entry goes first, against the byte budget and entry cap
   * below (see DEFAULT_DOCUMENT_CACHE_BUDGET_BYTES for the sizing).
   */
  documentCache: Map<string, DocumentCacheEntry>;

  /** Sum of the live entries' weights. */
  documentCacheBytes: number;

  /** The bounds the cache evicts against (open options). */
  documentCacheBudgetBytes: number;
  documentCacheMaxEntries: number;

  documentCacheStats: DocumentCacheStats;

  /** The coordinator this engine's cache reports to for the bound across
   * engines (the open option of the same name), if it has one. */
  documentCacheCoordinator?: DocumentCacheCoordinator;

  /**
   * Where {@link cacheDocumentForRevision} puts entries while a commit is
   * open, so they reach {@link Engine.documentCache} only once its rows are
   * durable. Absent outside {@link applyCommit}.
   */
  stagedDocumentCache?: Map<string, DocumentCacheEntry>;

  /**
   * Rows of the `branch` table, by branch name, as read outside a
   * transaction.
   *
   * Every read resolves its branch's existence, head and fork point, and the
   * table changes far less often than it is read. {@link runBranchWrite} is
   * the one way the engine writes it, and clears this map when it does. An
   * entry is recorded only outside a transaction, so a miss inside one reads
   * SQLite, and nothing a transaction wrote is remembered before it commits
   * or left behind when it rolls back.
   *
   * An entry is served without asking SQLite because this engine's
   * connection is the only one that writes its store. A write through any
   * other connection goes unseen here until this engine next writes the
   * table. A name with no row is never recorded, so the map is bounded by
   * the branches that exist rather than by the names readers ask for.
   */
  branchStates: Map<BranchName, Readonly<BranchState>>;
};

/** The first stale confirmed read of an entity on a branch in a declared scope. */
export type ConfirmedReadConflict = {
  of: string;
  scope: CellScope;
  /** Absent for the default branch. */
  branch?: BranchName;
  seq: number;
  conflictSeq: number;
};

export class ConflictError extends Error {
  /** Entity whose confirmed read went stale (stale-read conflicts only). */
  readonly of?: string;

  /** Scope of the entity whose confirmed read went stale, when one is named. */
  readonly scope?: CellScope;
  readonly branch?: BranchName;

  readonly seq?: number;
  readonly conflictSeq?: number;
  readonly conflicts?: readonly ConfirmedReadConflict[];
  constructor(
    message: string,
    conflicts?: readonly ConfirmedReadConflict[],
  ) {
    super(message);
    this.name = "ConflictError";
    if (conflicts !== undefined && conflicts.length > 0) {
      this.conflicts = [...conflicts];
      this.of = conflicts[0].of;
      this.scope = conflicts[0].scope;
      this.branch = conflicts[0].branch;
      this.seq = conflicts[0].seq;
      this.conflictSeq = conflicts[0].conflictSeq;
    }
  }
}

export class PreconditionFailedError extends Error {
  readonly precondition: "origin-committed" | "receipt-exists";

  constructor(
    precondition: PreconditionFailedError["precondition"],
    message: string,
  ) {
    super(message);
    this.name = "PreconditionFailedError";
    this.precondition = precondition;
  }
}

// ProtocolError moved to the wire-shape module (../v2.ts) with the shared
// scope-key vocabulary that throws it; re-exported near the imports above.

export class UnsupportedOpCodecError extends ProtocolError {
  override name = "UnsupportedOpCodecError";
}

export class OpFieldBaselineMismatchError extends ProtocolError {
  override name = "OpFieldBaselineMismatchError";
}

export class OpCursorMismatchError extends ProtocolError {
  override name = "OpCursorMismatchError";
}

export class OpHistoryUnavailableError extends ProtocolError {
  override name = "OpHistoryUnavailableError";
}

export class OpSubmissionMismatchError extends ProtocolError {
  override name = "OpSubmissionMismatchError";
}

export class OpFieldWriteConflictError extends ProtocolError {
  override name = "OpFieldWriteConflictError";
}

export class OpCodecError extends ProtocolError {
  override name = "OpCodecError";
}

export type OpenOptions = {
  url: URL;
  snapshotInterval?: number;
  snapshotRetention?: number;
  operationCheckpointInterval?: number;
  operationCodecs?: OperationCodecRegistry;

  /** Byte budget for the decoded-document cache, in encoded UTF-8 bytes of
   * the documents as stored (default DEFAULT_DOCUMENT_CACHE_BUDGET_BYTES;
   * what an entry weighs is under DocumentCacheEntry). */
  documentCacheBudgetBytes?: number;

  /** Entry cap for the same cache (default
   * DEFAULT_DOCUMENT_CACHE_MAX_ENTRIES). */
  documentCacheMaxEntries?: number;

  /**
   * The {@link DocumentCacheCoordinator} bounding decoded documents across
   * the engines that share it (a Server's spaces). The cache reports to it
   * on every access — a lookup that finds an entry refreshes this engine's
   * recency; an insertion
   * also grows the total and trims least-recently-used engines first — so
   * the bound holds at every return whichever path reached the engine, a
   * retained engine's direct reads included.
   */
  documentCacheCoordinator?: DocumentCacheCoordinator;
};

export type InvocationRecord = {
  iss: string;
  aud?: string | null;
  cmd: string;
  sub: string;
  args?: FabricValue;
  [key: string]: FabricValue;
};

export type AuthorizationRecord = FabricValue;

export type ApplyCommitOptions = {
  sessionId: SessionId;
  space?: string;
  principal?: string;
  invocation?: InvocationRecord;
  invocationPayload?: FabricValue;
  authorization?: AuthorizationRecord;
  commit: ClientCommit;

  /** Map of cell-db id -> attach alias for `sqlite` ops in this commit. The
   *  server attaches these BEFORE applyCommit (ATTACH can't run in a txn); the
   *  apply loop executes the SQL inside the commit's transaction against the
   *  alias. (docs/specs/sqlite-builtin/plans/atomic-writes.md) */
  sqliteAttachments?: ReadonlyMap<string, string>;

  /** The commit's class (docs/specs/server-side-execution/protocol.md §1),
   *  determined by the ADMISSION PATH that processed the commit — the
   *  session-facing transact path is `authored` (the default here, since
   *  `applyCommit` is that path's admission core), the memory server's own
   *  direct writes pass `system`, and only a lease-holding SpaceServer will
   *  pass `derived` (Phase 1 stage B). Never populated from any
   *  client-supplied value: `ClientCommit` cannot express a class, so a field
   *  smuggled into the payload is inert. */
  commitClass?: CommitClass;

  /** The producing lease holder of a `derived`-class commit — the DR1
   *  per-process identity the SpaceServer minted at process start
   *  (serving-loop.md §2). Admission compares it against the space's live
   *  `execution_lease` row: one equality check, judged by this process's own
   *  clock. Server-internal like `commitClass`: `ClientCommit` cannot express
   *  a holder, and no session-facing path supplies one. Meaningless (and
   *  ignored) on other classes. */
  holder?: string;

  /** Per-write identity annotations of a `derived`-class commit
   *  (protocol.md §1): the explicit `scope_key` on scoped writes
   *  (ADDRESSING — consumed here to key rows, since the service envelope
   *  has no session to derive keys from) and the acting identity per
   *  action run (ATTRIBUTION — stored, never read by admission).
   *  Server-internal like `commitClass`; rejected on any other class
   *  (protocol.md §7's closed list). */
  annotations?: readonly DerivedWriteAnnotation[];

  /** Server-internal (the wave path only — applyWaveCommit sets it when
   *  the wave carries outbound append rows): permit a commit with zero
   *  operations. An appends-only wave MUST still commit — its durable
   *  rows ride this very transaction (FP1, serving-loop.md §5), and a
   *  refusal would lose the appends with nothing to re-emit them. Never
   *  reachable from any session-facing path. */
  allowEmptyOperations?: boolean;

  /** The eventIds whose handler consequences this `derived`-class commit
   *  carries (protocol.md §7 — `consequenceOf`, derived only; bounded by
   *  the wave's input, never graph-scaled). Stored on the commit row;
   *  rejected on any other class. */
  consequenceOf?: readonly string[];

  /** The watermark this `derived`-class commit is current through
   *  (protocol.md §4, §7 — `derivedThrough`, derived only; every split of
   *  one wave repeats the same value). Stored on the commit row; rejected
   *  on any other class. Optional even on derived commits: a wave produced
   *  outside a serving loop (tests driving the accumulator directly) has
   *  no watermark to carry, and the column stays NULL. */
  derivedThrough?: number;

  /** Server-produced AUTHORED admission (protocol.md §2's delegated row,
   *  §2b — outbox event appends, `.inSpace` provisioning): the commit's
   *  metadata carries the ORIGINATING chain actor + the capability grant,
   *  and admission validates the grant against the target — a
   *  delegated-capability check, NEVER session-identity impersonation.
   *  Scoped writes key from the validated CARRIED identity (scopes.md §5:
   *  consequences land in the actor's instances). Only meaningful with
   *  the (default) authored class; refused elsewhere. Like the other
   *  server-internal carriage, `ClientCommit` cannot express it. */
  delegated?: {
    actingPrincipal: string;
    actingSession?: string;
    capabilityRef: string;

    /** The Phase-3 floor carve-out for sessionless space-scope emissions
     *  (SHAPE RULED 2026-08-05, protocol.md §2; implemented with Phase
     *  3's events): the completeness floor admits an ABSENT acting
     *  principal iff the entry is DECLARED sessionless-space-scope —
     *  `firedAt` stamps `{ session: "server" }` with NO user key, and
     *  grant presence stays mandatory. Userless WITHOUT the declaration
     *  is still refused (the floor negative both ways). A declaration
     *  alongside a present acting identity is a contradiction and is
     *  refused too — the declaration names a chain with NO actor. */
    sessionlessSpaceScope?: boolean;
  };

  /** Server-owned OW54 Retry admission. The commit retains a distinct
   *  server transaction identity while the new event is attributed to the
   *  authenticated user's current session. Only valid on `system` commits,
   *  and only for declared appends carrying `retryOf`. */
  systemEventActor?: {
    principal: string;
    sessionId: SessionId;
  };
};

export type AppliedRevision = {
  id: EntityId;
  scope?: CellScope;
  scopeKey: string;
  branch: BranchName;
  seq: number;
  opIndex: number;
  commitSeq: number;
  op: SetOperation["op"] | PatchOperation["op"] | DeleteOperation["op"];
  document?: EntityDocument;
  patches?: PatchOp[];
};

export type CommitReadDropReason =
  | "stale-confirmed-read"
  | "stale-pending-read"
  | "pending-read-missing";

export type AppliedCommit = {
  seq: number;
  branch: BranchName;
  revisions: AppliedRevision[];

  /** True when the commit was an exact REPLAY of one this session
   * already applied — the stored result was returned and NOTHING was
   * inserted. Side-effect carriage riding the apply (the wave commit's
   * outbox rows, FP1) keys off this: a replay must not re-run inserts
   * whose originals rode the first application (the rows may since
   * have been delivered and retired — re-inserting resurrects
   * delivered appends as duplicate delivery work). */
  replayed?: true;

  /**
   * Operation indexes whose `cid:` set matched the stored content exactly
   * and applied as a no-op: no revision, no head advance, no dirty mark.
   * The commit itself still records and advances the space log.
   */
  elidedOpIndexes?: number[];

  operationResolutions?: ApplyOpResolution[];
};

export type ReadOptions = {
  id: EntityId;
  scope?: CellScope;
  principal?: string;
  sessionId?: SessionId;
  branch?: BranchName;
  seq?: number;

  /** The explicit scope INSTANCE to read (protocol.md §2's read row —
   *  the read half of the transaction identity model). When present it
   *  bypasses the session-identity resolution: the caller (a lease
   *  holder — admission enforced at the server layer, not here) names
   *  the instance directly. When absent, the scope resolves from
   *  (principal, sessionId) as today. */
  scopeKey?: string;
};

export type EntityState = {
  id: EntityId;
  scope: CellScope;
  scopeKey: string;
  branch: BranchName;
  seq: number;
  opIndex: number;
  op: AppliedRevision["op"];
  document: EntityDocument | null;
};

export type PutBlobOptions = {
  value: Uint8Array;
  contentType: string;
};

export type BranchState = {
  name: BranchName;
  parentBranch: BranchName | null;
  forkSeq: number | null;
  createdSeq: number;
  headSeq: number;
  status: string;
};

type HeadRow = {
  seq: number;
  op_index: number;
};

type CommitRow = {
  seq: number;
  branch: string;
  original: string;
  resolution: string;
  class: string;
  holder: string | null;
};

type RevisionRow = {
  branch: string;
  id: string;
  scope_key: string;
  seq: number;
  op_index: number;
  op: AppliedRevision["op"];
  data: string | null;
  commit_seq: number;
};

type ReadRow = {
  seq: number;
  op_index: number;
  op: AppliedRevision["op"];
  data: string | null;
};

type SnapshotRow = {
  seq: number;
  value: string;
};

type BlobRow = {
  data: Uint8Array;
  content_type: string;
  size: number;
};

type BranchRow = {
  name: string;
  parent_branch: string | null;
  fork_seq: number | null;
  created_seq: number;
  head_seq: number;
  status: string;
};

export const DEFAULT_SNAPSHOT_INTERVAL = 10;
export const DEFAULT_SNAPSHOT_RETENTION = 2;
export const DEFAULT_OPERATION_CHECKPOINT_INTERVAL = 100;

/**
 * Defaults for the decoded-document cache ({@link Engine.documentCache}).
 *
 * Sized to keep one active corpus's working set resident, measured on a copy
 * of the production Topics board (129 topics, 2026-09-02): a full board page
 * load reads ~13,300 documents whose retained encoded size is 17.7 MB (135
 * topic piece docs at ~55 KB, ~800 computed cells at ~10 KB, every topic's
 * internals, mostly tiny). Under the earlier bound
 * (256 entries, cleared wholesale when full) no walk over that set ever found
 * a document cached, and every walk paid decode plus deep-freeze for every
 * document: about a second of server time per walk, most of it in the
 * freeze. With the set resident the same walk is under 100 ms and a board
 * load's server time fell from 4.1 s to 0.8 s.
 *
 * The byte budget is the retention bound — encoded UTF-8 bytes of the
 * document as stored, a proxy for the decoded graph kept alive (expect a few
 * times that in heap) — and the entry cap is the cardinality backstop, set
 * well above any real working set (a cap of 8,192 against that ~13,300-entry
 * load evicted 6,542 entries under 13 MB and served nothing).
 * Least-recently-read eviction under a budget SMALLER than a corpus's working
 * set serves nothing (each miss displaces what the next read wants), so the
 * per-space default errs on the side of fitting; the Server bounds the total
 * across spaces (its `documentCacheTotalBudgetBytes`), and a host lowers
 * either through the toolshed's MEMORY_DOCUMENT_CACHE_* variables.
 * `documentCaches` on /api/health/stats shows `evictions` when a space does
 * not fit. Superseded revisions, read once more at most, age out on their
 * own, which is what the old bound existed for.
 */
export const DEFAULT_DOCUMENT_CACHE_BUDGET_BYTES = 128 * 1024 * 1024;
export const DEFAULT_DOCUMENT_CACHE_MAX_ENTRIES = 65_536;

/**
 * Rejects, by name, a document-cache bound that is not a positive safe
 * integer; an absent one means the default and passes. Shared by `open`
 * and the Server's constructor, so a bad bound fails where it is configured
 * rather than at the first request that opens a space.
 */
export const validateDocumentCacheBounds = (
  bounds: Partial<
    Record<
      | "documentCacheBudgetBytes"
      | "documentCacheMaxEntries"
      | "documentCacheTotalBudgetBytes",
      number
    >
  >,
): void => {
  for (const [name, value] of Object.entries(bounds)) {
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
};

/**
 * The bound on decoded documents retained across the engines that share it:
 * a Server's spaces, under its `documentCacheTotalBudgetBytes`.
 *
 * Every cache access reports here, so both facts the bound rests on are
 * exact at every return whichever path reached the engine — a retained
 * engine handed to the runner as much as a request through the Server. The
 * total in bytes is kept incrementally (an insertion adds, an eviction of
 * any kind subtracts, a closed engine leaves), and recency is a set of
 * engines in access order that a lookup finding an entry, or an insertion,
 * re-inserts into. The
 * common under-budget insertion is therefore O(1), and over budget the trim
 * walks only its victims: least recently used engine first, oldest entries
 * first within it.
 *
 * Engine code only. The class is closed — a private field keeps duck-typed
 * substitutes out — so nothing a host wrote runs inside a cache access; in
 * particular nothing foreign runs after a commit is durable, when the
 * entries the commit staged reach the cache.
 */
export class DocumentCacheCoordinator {
  #budgetBytes: number;
  #bytes = 0;
  #evictions = 0;
  /** Least recently used first. */
  #engines = new Set<Engine>();

  constructor(budgetBytes: number) {
    validateDocumentCacheBounds({ documentCacheTotalBudgetBytes: budgetBytes });
    this.#budgetBytes = budgetBytes;
  }

  /** The bound, in encoded UTF-8 bytes. */
  get budgetBytes(): number {
    return this.#budgetBytes;
  }

  /** Bytes retained across every engine reporting here. */
  get bytes(): number {
    return this.#bytes;
  }

  /** Entries evicted to hold the total budget, lifetime. An engine's own
   * budget or cap evicts on its own account and is not counted here. */
  get evictions(): number {
    return this.#evictions;
  }

  /** Engines that have reported an access and not closed. */
  get engines(): number {
    return this.#engines.size;
  }

  /** A lookup found an entry in `engine`: it is now the most recently
   * used. */
  touched(engine: Engine): void {
    this.#engines.delete(engine);
    this.#engines.add(engine);
  }

  /** An entry of `weight` bytes left some engine's cache — on the engine's
   * own account (its budget or cap) or in a coordinator trim. */
  released(weight: number): void {
    this.#bytes -= weight;
  }

  /** `engine` retained an entry of `weight` bytes: it is the most recently
   * used, and if the total is now over budget the least recently used
   * engines give up their oldest entries until it fits again. The engine
   * that just inserted is the last to be asked. */
  admitted(engine: Engine, weight: number): void {
    this.#bytes += weight;
    this.touched(engine);
    if (this.#bytes <= this.#budgetBytes) return;
    for (const victim of this.#engines) {
      if (this.#bytes <= this.#budgetBytes) return;
      const before = victim.documentCacheStats.evictions;
      evictDocumentCacheEntries(victim, this.#bytes - this.#budgetBytes);
      this.#evictions += victim.documentCacheStats.evictions - before;
    }
  }

  /** `engine` closed: what it retained is gone. */
  removed(engine: Engine): void {
    if (this.#engines.delete(engine)) {
      this.#bytes -= engine.documentCacheBytes;
    }
  }
}

const prepareStatements = (database: Database): PreparedStatements => ({
  insertAuthorization: database.prepare(INSERT_AUTHORIZATION),
  insertBlob: database.prepare(INSERT_BLOB),
  insertBranch: database.prepare(INSERT_BRANCH),
  insertCommit: database.prepare(INSERT_COMMIT),
  insertInvocation: database.prepare(INSERT_INVOCATION),
  insertRevision: database.prepare(INSERT_REVISION),
  insertSnapshot: database.prepare(INSERT_SNAPSHOT),
  selectAtSeqLocal: database.prepare(SELECT_AT_SEQ_LOCAL),
  selectBlob: database.prepare(SELECT_BLOB),
  selectBranch: database.prepare(SELECT_BRANCH),
  selectBranches: database.prepare(SELECT_BRANCHES),
  selectCommitRevisions: database.prepare(SELECT_COMMIT_REVISIONS),
  selectCurrentLocal: database.prepare(SELECT_CURRENT_LOCAL),
  selectCurrentEntityId: database.prepare(SELECT_CURRENT_ENTITY_ID),
  selectCurrentEntityIds: database.prepare(SELECT_CURRENT_ENTITY_IDS),
  selectCurrentEntityIdPage: database.prepare(SELECT_CURRENT_ENTITY_ID_PAGE),
  selectCurrentEntityIdPageAfter: database.prepare(
    SELECT_CURRENT_ENTITY_ID_PAGE_AFTER,
  ),
  selectExistingCommit: database.prepare(SELECT_EXISTING_COMMIT),
  selectHead: database.prepare(SELECT_HEAD),
  selectLatestBase: database.prepare(SELECT_LATEST_BASE),
  selectLatestSnapshot: database.prepare(SELECT_LATEST_SNAPSHOT),
  selectLiveExecutionLease: database.prepare(SELECT_LIVE_EXECUTION_LEASE),
  selectNextSeq: database.prepare(SELECT_NEXT_SEQ),
  selectPatchConflicts: database.prepare(SELECT_PATCH_CONFLICTS),
  selectPatchConflictsExcludingSession: database.prepare(
    SELECT_PATCH_CONFLICTS_EXCLUDING_SESSION,
  ),
  selectPatchCount: database.prepare(SELECT_PATCH_COUNT),
  selectPatches: database.prepare(SELECT_PATCHES),
  selectPendingResolution: database.prepare(SELECT_PENDING_RESOLUTION),
  selectServerSeq: database.prepare(SELECT_SERVER_SEQ),
  selectSetDeleteConflict: database.prepare(SELECT_SET_DELETE_CONFLICT),
  selectSetDeleteConflictExcludingSession: database.prepare(
    SELECT_SET_DELETE_CONFLICT_EXCLUDING_SESSION,
  ),
  upsertHead: database.prepare(UPSERT_HEAD),
  updateCommitResolution: database.prepare(UPDATE_COMMIT_RESOLUTION),
  updateBranchHead: database.prepare(UPDATE_BRANCH_HEAD),
  deleteBranch: database.prepare(DELETE_BRANCH),
  deleteOldSnapshots: database.prepare(DELETE_OLD_SNAPSHOTS),
});

const hasColumn = (
  database: Database,
  table: string,
  column: string,
): boolean => {
  const rows = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<
    { name: string }
  >;
  return rows.some((row) => row.name === column);
};

const columnDefault = (
  database: Database,
  table: string,
  column: string,
): string | null | undefined => {
  const rows = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<
    { name: string; dflt_value: string | null }
  >;
  return rows.find((row) => row.name === column)?.dflt_value;
};

const hasTable = (database: Database, table: string): boolean =>
  database.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = :table
  `).get({ table }) !== undefined;

const migrateIntegratedOperationIds = (database: Database): void => {
  if (
    !hasTable(database, "op_integrated") ||
    hasColumn(database, "op_integrated", "op_id")
  ) {
    return;
  }

  database.transaction(() => {
    database.exec(`
      ALTER TABLE op_integrated RENAME TO op_integrated_id_migration;

      CREATE TABLE op_integrated (
        branch         TEXT    NOT NULL DEFAULT '',
        id             TEXT    NOT NULL,
        scope_key      TEXT    NOT NULL DEFAULT 'space',
        path           JSON    NOT NULL,
        epoch          INTEGER NOT NULL,
        version        INTEGER NOT NULL,
        op_id          TEXT    NOT NULL UNIQUE,
        submission_id  TEXT    NOT NULL,
        payload        JSON    NOT NULL,
        commit_seq     INTEGER NOT NULL,
        PRIMARY KEY (branch, id, scope_key, path, epoch, version),
        FOREIGN KEY (commit_seq) REFERENCES "commit"(seq)
      );
    `);

    const rows = database.prepare(`
      SELECT branch, id, scope_key, path, epoch, version,
             submission_id, payload, commit_seq
      FROM op_integrated_id_migration
      ORDER BY branch, id, scope_key, path, epoch, version
    `).all() as Array<{
      branch: BranchName;
      id: EntityId;
      scope_key: string;
      path: string;
      epoch: number;
      version: number;
      submission_id: string;
      payload: string;
      commit_seq: number;
    }>;
    const insert = database.prepare(`
      INSERT INTO op_integrated (
        branch, id, scope_key, path, epoch, version, op_id,
        submission_id, payload, commit_seq
      ) VALUES (
        :branch, :id, :scope_key, :path, :epoch, :version, :op_id,
        :submission_id, :payload, :commit_seq
      )
    `);
    for (const row of rows) {
      insert.run({
        ...row,
        op_id: integratedOperationId(
          {
            branch: row.branch,
            id: row.id,
            scopeKey: row.scope_key,
            path: parsePointer(row.path),
          },
          row.epoch,
          row.version,
        ),
      });
    }
    database.exec("DROP TABLE op_integrated_id_migration");
  }).immediate();
};

type ForeignKeyShape = {
  table: string;
  from: string[];
  to: string[];
};

const migrateScopedEntityTables = (database: Database): void => {
  if (hasColumn(database, "revision", "scope_key")) {
    return;
  }

  database.exec(`
BEGIN TRANSACTION;

DROP INDEX IF EXISTS idx_revision_branch_id_seq;
DROP INDEX IF EXISTS idx_revision_commit;
DROP INDEX IF EXISTS idx_revision_branch;
DROP INDEX IF EXISTS idx_head_branch;
DROP INDEX IF EXISTS idx_snapshot_lookup;

ALTER TABLE revision RENAME TO revision_unscoped_migration;
ALTER TABLE head RENAME TO head_unscoped_migration;
ALTER TABLE snapshot RENAME TO snapshot_unscoped_migration;

CREATE TABLE revision (
  branch      TEXT    NOT NULL DEFAULT '',
  id          TEXT    NOT NULL,
  scope_key   TEXT    NOT NULL DEFAULT 'space',
  seq         INTEGER NOT NULL,
  op_index    INTEGER NOT NULL,
  op          TEXT    NOT NULL,
  data        JSON,
  commit_seq  INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index),
  FOREIGN KEY (commit_seq) REFERENCES "commit"(seq)
);
CREATE INDEX idx_revision_branch_id_seq
  ON revision (branch, id, scope_key, seq, op_index);
CREATE INDEX idx_revision_commit
  ON revision (commit_seq);
CREATE INDEX idx_revision_branch
  ON revision (branch, seq);

CREATE TABLE head (
  branch    TEXT    NOT NULL,
  id        TEXT    NOT NULL,
  scope_key TEXT    NOT NULL DEFAULT 'space',
  seq       INTEGER NOT NULL,
  op_index  INTEGER NOT NULL,
  op        TEXT    NOT NULL CHECK (op IN ('set', 'patch', 'delete')),
  PRIMARY KEY (branch, id, scope_key)
);
CREATE INDEX idx_head_branch ON head (branch);

CREATE TABLE snapshot (
  branch    TEXT    NOT NULL DEFAULT '',
  id        TEXT    NOT NULL,
  scope_key TEXT    NOT NULL DEFAULT 'space',
  seq       INTEGER NOT NULL,
  value     JSON    NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq)
);
CREATE INDEX idx_snapshot_lookup
  ON snapshot (branch, id, scope_key, seq);

INSERT INTO revision (branch, id, scope_key, seq, op_index, op, data, commit_seq)
SELECT branch, id, 'space', seq, op_index, op, data, commit_seq
FROM revision_unscoped_migration;

INSERT INTO head (branch, id, scope_key, seq, op_index, op)
SELECT h.branch, h.id, 'space', h.seq, h.op_index, r.op
FROM head_unscoped_migration h
JOIN revision r
  ON r.branch = h.branch
  AND r.id = h.id
  AND r.scope_key = 'space'
  AND r.seq = h.seq
  AND r.op_index = h.op_index;

INSERT INTO snapshot (branch, id, scope_key, seq, value)
SELECT branch, id, 'space', seq, value
FROM snapshot_unscoped_migration;

DROP TABLE revision_unscoped_migration;
DROP TABLE head_unscoped_migration;
DROP TABLE snapshot_unscoped_migration;

COMMIT;
`);
};

const migrateHeadCurrentOp = (database: Database): void => {
  if (
    !hasColumn(database, "head", "op") ||
    columnDefault(database, "head", "op") !== null
  ) {
    database.exec(`
BEGIN TRANSACTION;

DROP INDEX IF EXISTS idx_head_branch;
DROP INDEX IF EXISTS idx_head_live_entity_ids;

ALTER TABLE head RENAME TO head_current_op_migration;

CREATE TABLE head (
  branch    TEXT    NOT NULL,
  id        TEXT    NOT NULL,
  scope_key TEXT    NOT NULL DEFAULT 'space',
  seq       INTEGER NOT NULL,
  op_index  INTEGER NOT NULL,
  op        TEXT    NOT NULL CHECK (op IN ('set', 'patch', 'delete')),
  PRIMARY KEY (branch, id, scope_key)
);
CREATE INDEX idx_head_branch ON head (branch);

INSERT INTO head (branch, id, scope_key, seq, op_index, op)
SELECT
  h.branch,
  h.id,
  h.scope_key,
  h.seq,
  h.op_index,
  (
  SELECT r.op
  FROM revision r
  WHERE r.branch = h.branch
    AND r.id = h.id
    AND r.scope_key = h.scope_key
    AND r.seq = h.seq
    AND r.op_index = h.op_index
  )
FROM head_current_op_migration h;

DROP TABLE head_current_op_migration;

COMMIT;
`);
  }

  database.exec(`
CREATE INDEX IF NOT EXISTS idx_head_live_entity_ids
  ON head (branch, scope_key, id, op)
  WHERE op <> 'delete';
`);
};

// Server-execution v2 stage A: every commit row carries its `class`
// (docs/specs/server-side-execution/protocol.md §1). Pre-class rows backfill
// as 'authored' via the column default — on main every historical commit came
// through client-session admission, and the distinction the class exists for
// (`derived` vs the rest) has no historical instances to preserve.
const migrateCommitClass = (database: Database): void => {
  if (hasColumn(database, "commit", "class")) {
    return;
  }

  database.exec(`
ALTER TABLE "commit"
ADD COLUMN class TEXT NOT NULL DEFAULT 'authored';
`);
};

// Server-execution v2 stage B: derived-class commits carry their producing
// lease holder (protocol.md §7 — `holder`, derived only). Historical rows
// stay NULL: no derived commit could exist before the lease admission check
// this column lands with, so there is nothing to backfill. Runs after
// migrateCommitClass so migrated stores and fresh stores agree on column
// order (class, then holder).
const migrateCommitHolder = (database: Database): void => {
  if (hasColumn(database, "commit", "holder")) {
    return;
  }

  database.exec(`
ALTER TABLE "commit"
ADD COLUMN holder TEXT;
`);
};

// Server-execution v2 stage D: derived-class commits carry their per-write
// identity annotations and consequenceOf inside the commit row (protocol.md
// §1, §7). Historical rows stay NULL — both fields are derived-only and no
// derived commit predates them. Runs after migrateCommitHolder so migrated
// stores and fresh stores agree on column order (class, holder, annotations,
// consequence_of).
const migrateCommitWaveCarriage = (database: Database): void => {
  // One guard per column, matching the prior migrations' shape: ALTERs
  // are not transactional as a pair, and migrations run on every store
  // open — a single first-column guard would turn a crash between the
  // two ALTERs into a store with `annotations` present and
  // `consequence_of` missing FOREVER (the guard forever satisfied, the
  // second ALTER forever skipped, every commit INSERT failing).
  if (!hasColumn(database, "commit", "annotations")) {
    database.exec(`
ALTER TABLE "commit"
ADD COLUMN annotations JSON;
`);
  }
  if (!hasColumn(database, "commit", "consequence_of")) {
    database.exec(`
ALTER TABLE "commit"
ADD COLUMN consequence_of JSON;
`);
  }
};

// Server-execution v2 stage F: derived-class commits carry the watermark
// they are current through (protocol.md §4, §7 — `derivedThrough`, derived
// only). Historical rows stay NULL: no serving loop existed to advance a
// watermark before this column. Runs after migrateCommitWaveCarriage so
// migrated stores and fresh stores agree on column order.
const migrateCommitDerivedThrough = (database: Database): void => {
  if (hasColumn(database, "commit", "derived_through")) {
    return;
  }

  database.exec(`
ALTER TABLE "commit"
ADD COLUMN derived_through INTEGER;
`);
};

// Server-execution v2 stage F: server-produced authored commits carry the
// delegated acting identity + capability grant they were admitted under
// (protocol.md §2's delegated row, §2b). Historical rows stay NULL — no
// delegated producer predates this column trio. One guard per column
// (the migrateCommitWaveCarriage crash-window rationale).
const migrateCommitDelegation = (database: Database): void => {
  for (
    const column of ["acting_principal", "acting_session", "capability_ref"]
  ) {
    if (!hasColumn(database, "commit", column)) {
      database.exec(`
ALTER TABLE "commit"
ADD COLUMN ${column} TEXT;
`);
    }
  }
};

// Server-execution v2 Phase 3 (events-down): the outbox rows gain the
// stream link carriage (the delivered entry's self-describing `stream`
// field) and the OW15 sessionless-space-scope declaration. Stage-G-era
// rows predate both: their NULL link falls back to a path-less stream at
// the sidecar id, and NULL declaration means "not declared" — exactly the
// fail-closed reading the carve-out requires.
const migrateExecutionOutboxEventCarriage = (database: Database): void => {
  if (!hasColumn(database, "execution_outbox", "target_stream_link")) {
    database.exec(`
ALTER TABLE execution_outbox
ADD COLUMN target_stream_link TEXT;
`);
  }
  if (!hasColumn(database, "execution_outbox", "sessionless_space_scope")) {
    database.exec(`
ALTER TABLE execution_outbox
ADD COLUMN sessionless_space_scope INTEGER;
`);
  }
  if (!hasColumn(database, "execution_outbox", "source_event")) {
    database.exec(`
ALTER TABLE execution_outbox
ADD COLUMN source_event TEXT;
`);
  }
};

// Server-execution v2 Phase 1 stage C.2: the observation-payload tables are
// REPLACED by the scheduler_basis index (serving-loop.md §3b). The drop list
// is §3b's SEVEN tables, deliberately not a constant enumerating six (D6 —
// scheduler_context_floor was created and dropped through separate statements
// and is easy to leave behind). Satellites drop before the scheduler_
// observation spine they FK into; scheduler_basis itself is created by INIT.
// NO BACKFILL (D10): rows keyed by process_generation history cannot be
// reinterpreted as overwrite-in-place basis state, so a store that had opted
// into persistentSchedulerState loses warm start once — the first activation
// re-marks everything dirty and recomputes, exactly what an absent index
// means.
const migrateSchedulerObservationTablesToBasis = (database: Database): void => {
  database.transaction(() => {
    database.exec(`
      DROP TABLE IF EXISTS scheduler_observation_replay;
      DROP TABLE IF EXISTS scheduler_read_index;
      DROP TABLE IF EXISTS scheduler_write_index;
      DROP TABLE IF EXISTS scheduler_action_state;
      DROP TABLE IF EXISTS scheduler_action_snapshot;
      DROP TABLE IF EXISTS scheduler_observation;
      DROP TABLE IF EXISTS scheduler_context_floor;
    `);
  }).immediate();
};

export const open = async (
  {
    url,
    snapshotInterval = DEFAULT_SNAPSHOT_INTERVAL,
    snapshotRetention = DEFAULT_SNAPSHOT_RETENTION,
    operationCheckpointInterval = DEFAULT_OPERATION_CHECKPOINT_INTERVAL,
    operationCodecs = createDefaultOperationCodecRegistry(),
    documentCacheBudgetBytes = DEFAULT_DOCUMENT_CACHE_BUDGET_BYTES,
    documentCacheMaxEntries = DEFAULT_DOCUMENT_CACHE_MAX_ENTRIES,
    documentCacheCoordinator,
  }: OpenOptions,
): Promise<Engine> => {
  if (
    !Number.isSafeInteger(operationCheckpointInterval) ||
    operationCheckpointInterval <= 0
  ) {
    throw new TypeError(
      "operationCheckpointInterval must be a positive safe integer",
    );
  }
  validateDocumentCacheBounds({
    documentCacheBudgetBytes,
    documentCacheMaxEntries,
  });
  const database = await new Database(toDatabaseAddress(url), { create: true });
  database.exec(NEW_DB_PRAGMAS);
  database.exec(PRAGMAS);
  database.exec(INIT);
  migrateScopedEntityTables(database);
  migrateHeadCurrentOp(database);
  migrateCommitClass(database);
  migrateCommitHolder(database);
  migrateCommitWaveCarriage(database);
  migrateCommitDerivedThrough(database);
  migrateCommitDelegation(database);
  migrateExecutionOutboxEventCarriage(database);
  migrateSchedulerObservationTablesToBasis(database);
  migrateIntegratedOperationIds(database);
  return {
    url,
    database,
    snapshotInterval,
    snapshotRetention,
    operationCheckpointInterval,
    legacyCommitMetadataRefsRequired: commitMetadataRefsRequired(database),
    operationCodecs,
    statements: prepareStatements(database),
    documentCache: new Map(),
    documentCacheBytes: 0,
    documentCacheBudgetBytes,
    documentCacheMaxEntries,
    documentCacheStats: {
      hits: 0,
      misses: 0,
      evictions: 0,
      patchReplays: 0,
      resumes: 0,
    },
    ...(documentCacheCoordinator === undefined
      ? {}
      : { documentCacheCoordinator }),
    branchStates: new Map(),
  };
};

/** A peek at the engine's document cache: counters and current occupancy. */
export const documentCacheDiagnostics = (
  engine: Engine,
): DocumentCacheDiagnostics => ({
  ...engine.documentCacheStats,
  entries: engine.documentCache.size,
  bytes: engine.documentCacheBytes,
  budgetBytes: engine.documentCacheBudgetBytes,
  maxEntries: engine.documentCacheMaxEntries,
});

/**
 * Evict the least recently read entries until at least `bytes` have been
 * freed or the cache is empty; returns what was freed. The coordinator's
 * cross-engine budget drains engines through this, least recently used
 * engine first.
 */
export const evictDocumentCacheEntries = (
  engine: Engine,
  bytes: number,
): number => {
  let freed = 0;
  while (freed < bytes && engine.documentCache.size > 0) {
    freed += dropOldestDocumentCacheEntry(engine);
  }
  return freed;
};

/** Drop the least recently read entry and return its weight. Every eviction
 * passes here, so the engine's byte count and its coordinator's total move
 * together. */
const dropOldestDocumentCacheEntry = (engine: Engine): number => {
  const oldestKey = engine.documentCache.keys().next().value!;
  const oldest = engine.documentCache.get(oldestKey)!;
  engine.documentCache.delete(oldestKey);
  engine.documentCacheBytes -= oldest.weight;
  engine.documentCacheStats.evictions++;
  engine.documentCacheCoordinator?.released(oldest.weight);
  return oldest.weight;
};

const utf8Encoder = new TextEncoder();

/** Encoded UTF-8 bytes of stored text — the unit every document-cache bound
 * is stated in. `String.length` counts UTF-16 code units, which undercounts
 * anything outside ASCII. */
const storedByteLength = (text: string | null | undefined): number =>
  text ? utf8Encoder.encode(text).byteLength : 0;

export const close = (engine: Engine): void => {
  // The cache goes with the engine, and its coordinator stops counting it.
  engine.documentCacheCoordinator?.removed(engine);
  engine.documentCache.clear();
  engine.documentCacheBytes = 0;
  engine.database.close();
};

export const createBranch = (
  engine: Engine,
  name: BranchName,
  options: {
    parentBranch?: BranchName;
    forkSeq?: number;
  } = {},
): BranchState =>
  engine.database.transaction((txEngine: Engine) => {
    // A copy, since the engine may be holding the state it read.
    if (name === DEFAULT_BRANCH) {
      return { ...requireBranch(txEngine, DEFAULT_BRANCH) };
    }
    const existing = getBranch(txEngine, name);
    if (existing !== null) {
      return { ...existing };
    }
    const parentBranch = options.parentBranch ?? DEFAULT_BRANCH;
    const parent = requireBranch(txEngine, parentBranch);
    const forkSeq = options.forkSeq ?? parent.headSeq;
    runBranchWrite(txEngine, txEngine.statements.insertBranch, {
      name,
      parent_branch: parentBranch,
      fork_seq: forkSeq,
      created_seq: forkSeq,
      head_seq: forkSeq,
    });
    return { ...requireBranch(txEngine, name) };
  }).immediate(engine);

export const deleteBranch = (
  engine: Engine,
  branch: BranchName,
): void => {
  requireBranch(engine, branch);
  runBranchWrite(engine, engine.statements.deleteBranch, { branch });
};

export const listBranches = (engine: Engine): BranchState[] => {
  return (engine.statements.selectBranches.all() as BranchRow[]).map(
    toBranchState,
  );
};

export const listEntityIds = (
  engine: Engine,
): EntityId[] => {
  return (engine.statements.selectCurrentEntityIds.all({
    branch: DEFAULT_BRANCH,
    scope_key: DEFAULT_SCOPE_KEY,
  }) as { id: EntityId }[]).map(({ id }) => id);
};

export type EntityIdPageOptions = {
  after?: EntityId;
  limit: number;
};

export const listEntityIdPage = (
  engine: Engine,
  { after, limit }: EntityIdPageOptions,
): EntityId[] => {
  const statement = after === undefined
    ? engine.statements.selectCurrentEntityIdPage
    : engine.statements.selectCurrentEntityIdPageAfter;
  return (statement.all({
    branch: DEFAULT_BRANCH,
    scope_key: DEFAULT_SCOPE_KEY,
    limit,
    ...(after === undefined ? {} : { after }),
  }) as { id: EntityId }[]).map(({ id }) => id);
};

export const entityIdExists = (
  engine: Engine,
  id: EntityId,
): boolean => {
  return engine.statements.selectCurrentEntityId.get({
    branch: DEFAULT_BRANCH,
    scope_key: DEFAULT_SCOPE_KEY,
    id,
  }) !== undefined;
};

export const read = (
  engine: Engine,
  { id, branch = DEFAULT_BRANCH, seq, scope, principal, sessionId, scopeKey }:
    ReadOptions,
): EntityDocument | null => {
  return readState(engine, {
    id,
    branch,
    seq,
    scope,
    principal,
    sessionId,
    // Forward the explicit instance (protocol.md §2's read row): dropping
    // it here would silently resolve the scope from (principal,
    // sessionId) and read the WRONG document.
    ...(scopeKey === undefined ? {} : { scopeKey }),
  })?.document ?? null;
};

export const queryOperationField = (
  engine: Engine,
  {
    id,
    path,
    scope,
    principal,
    sessionId,
    branch = DEFAULT_BRANCH,
    after,
  }: OperationFieldQuery,
): OperationFieldSnapshot => {
  assertDefaultOperationBranch(branch);
  validateOperationPath(path);
  if (typeof id !== "string" || id.length === 0) {
    throw new ProtocolError("operation field id is malformed");
  }
  if (after !== undefined && !validateCursor(after)) {
    throw new OpCursorMismatchError(
      "operation field query cursor is malformed",
    );
  }
  const declaredScope = normalizeScope(scope);
  const scopeKey = resolveScopeKey(scope, { principal, sessionId });
  const params = operationFieldParams(branch, id, scopeKey, path);
  const field = selectOperationField(engine, params);
  const document = readStateForScopeKey(engine, {
    id,
    branch,
    scope: declaredScope,
    scopeKey,
  })?.document ?? null;
  const active = field?.active === 1;
  let currentMaterialized: FabricValue;
  try {
    currentMaterialized = valueAtOperationPath(document, path);
  } catch (error) {
    if (active) throw error;
    // An inactive watch remains meaningful after its field or owning entity is
    // deleted. Null is the ordinary projection for that absent value; a later
    // activation still requires the field to exist and pass codec validation.
    currentMaterialized = null;
  }
  const epoch = active ? field.epoch : null;
  const retainedVersion = active
    ? retainedOperationVersion(engine, params, field)
    : 0;
  if (
    active && after?.epoch === epoch && after.version > field.version
  ) {
    throw new OpCursorMismatchError(
      "operation field query cursor is in the future",
    );
  }
  const reset = active && (
    (after === undefined && retainedVersion > 0) ||
    (after !== undefined && after.epoch !== epoch) ||
    (after?.epoch === epoch && after.version < retainedVersion)
  );
  const afterVersion = active && !reset && after?.epoch === epoch
    ? after.version
    : reset
    ? field.version
    : 0;
  return {
    id,
    ...(declaredScope === DEFAULT_SCOPE ? {} : { scope: declaredScope }),
    path,
    branch,
    scopeKey,
    active,
    codec: active ? field.codec : null,
    cursor: active ? { epoch: field.epoch, version: field.version } : null,
    baselineHash: active
      ? field.baseline_hash
      : operationBaselineHash(currentMaterialized),
    materialized: active
      ? decodeMemoryBoundary(field.materialized)
      : currentMaterialized,
    ...(active
      ? {
        retainedFrom: { epoch: field.epoch, version: retainedVersion },
        ...(reset ? { reset: true } : {}),
      }
      : {}),
    operations: active
      ? decodedIntegratedOperations(
        field.epoch,
        selectIntegratedOperations(engine, {
          ...params,
          epoch: field.epoch,
          after_version: afterVersion,
        }),
      )
      : [],
  };
};

export type OperationHistoryPruneResult = {
  cursor: OpCursor;
  prunedOperations: number;
};

/**
 * Prunes replay rows only when the active head has a storage-owned checkpoint
 * that exactly matches both collaborative and ordinary materialized state.
 * Submitted rows remain available for audit and duplicate detection.
 */
export const pruneOperationFieldHistory = (
  engine: Engine,
  {
    id,
    path,
    scope,
    principal,
    sessionId,
    branch = DEFAULT_BRANCH,
  }: OperationFieldQuery,
): OperationHistoryPruneResult =>
  engine.database.transaction((txEngine: Engine) => {
    assertDefaultOperationBranch(branch);
    validateOperationPath(path);
    if (typeof id !== "string" || id.length === 0) {
      throw new ProtocolError("operation field id is malformed");
    }
    const declaredScope = normalizeScope(scope);
    const scopeKey = resolveScopeKey(scope, { principal, sessionId });
    const params = operationFieldParams(branch, id, scopeKey, path);
    const field = selectOperationField(txEngine, params);
    if (!field || field.active !== 1) {
      throw new OpHistoryUnavailableError(
        "only active operation field history can be pruned",
      );
    }
    const checkpoint = txEngine.database.prepare(`
      SELECT version, materialized
      FROM op_checkpoint
      WHERE branch = :branch AND id = :id AND scope_key = :scope_key
        AND path = :path AND epoch = :epoch AND version <= :version
      ORDER BY version DESC
      LIMIT 1
    `).get({
      ...params,
      epoch: field.epoch,
      version: field.version,
    }) as { version: number; materialized: string } | undefined;
    if (!checkpoint || checkpoint.version === 0) {
      throw new OpHistoryUnavailableError(
        "operation field has no compacting checkpoint",
      );
    }
    const replayRows = selectIntegratedOperations(txEngine, {
      ...params,
      epoch: field.epoch,
      after_version: checkpoint.version,
    });
    if (
      replayRows.length !== field.version - checkpoint.version ||
      replayRows.some((row, index) =>
        row.version !== checkpoint.version + index + 1
      )
    ) {
      throw new ProtocolError(
        "operation history after checkpoint is not contiguous",
      );
    }
    let replayed = decodeMemoryBoundary(checkpoint.materialized);
    const codec = txEngine.operationCodecs.require(field.codec);
    for (const row of replayRows) {
      const result = codec.integrate({
        materialized: replayed,
        submitted: decodeMemoryBoundary(row.payload),
        intervening: [],
      });
      if (
        result.operations.length !== 1 ||
        encodeMemoryBoundary(result.operations[0]) !== row.payload
      ) {
        throw new ProtocolError(
          "operation codec did not reproduce integrated history",
        );
      }
      replayed = result.materialized;
    }
    const document = readStateForScopeKey(txEngine, {
      id,
      branch,
      scope: declaredScope,
      scopeKey,
    })?.document ?? null;
    const ordinaryMaterialized = encodeMemoryBoundary(
      valueAtOperationPath(document, path),
    );
    if (
      encodeMemoryBoundary(replayed) !== field.materialized ||
      field.materialized !== ordinaryMaterialized
    ) {
      throw new ProtocolError(
        "operation checkpoint diverged from materialized field state",
      );
    }
    const prunedOperations = txEngine.database.prepare(`
      DELETE FROM op_integrated
      WHERE branch = :branch AND id = :id AND scope_key = :scope_key
        AND path = :path AND epoch = :epoch AND version <= :version
    `).run({
      ...params,
      epoch: field.epoch,
      version: checkpoint.version,
    });
    return {
      cursor: { epoch: field.epoch, version: checkpoint.version },
      prunedOperations,
    };
  }).immediate(engine);

export const readState = (
  engine: Engine,
  {
    id,
    branch = DEFAULT_BRANCH,
    seq,
    scope,
    principal,
    sessionId,
    scopeKey: explicitScopeKey,
  }: ReadOptions,
): EntityState | null => {
  const declaredScope = explicitScopeKey !== undefined
    ? scopeOfScopeKey(explicitScopeKey)
    : normalizeScope(scope);
  const scopeKey = explicitScopeKey ??
    resolveScopeKey(scope, { principal, sessionId });
  return readStateForScopeKey(engine, {
    id,
    branch,
    seq,
    scope: declaredScope,
    scopeKey,
  });
};

const readStateForScopeKey = (
  engine: Engine,
  {
    id,
    scopeKey,
    branch = DEFAULT_BRANCH,
    seq,
    scope,
  }: {
    id: EntityId;
    scope?: CellScope;
    scopeKey: string;
    branch?: BranchName;
    seq?: number;
  },
): EntityState | null => {
  const declaredScope = scope ?? scopeOfScopeKey(scopeKey);
  const resolved = readRowForBranch(engine, { id, scopeKey, branch, seq });
  if (resolved === null) {
    return null;
  }

  const { row, branch: resolvedBranch } = resolved;
  // The revision this read resolved to. What it decodes to cannot change, so
  // a hit here is the same answer the work below would produce.
  const cacheKey = documentCacheKey(
    resolvedBranch,
    id,
    scopeKey,
    row.seq,
    row.op_index,
    row.op,
    row.data?.length ?? -1,
  );
  let document: EntityDocument | null;
  const cached = cachedDocumentForRevision(engine, cacheKey);
  if (cached !== undefined) {
    engine.documentCacheStats.hits++;
    document = cached.document;
  } else {
    engine.documentCacheStats.misses++;
    let weight = storedByteLength(row.data);
    switch (row.op) {
      case "set":
        document = decodeStoredDocument(row.data);
        break;
      case "delete":
        document = null;
        break;
      case "patch": {
        const reconstructed = reconstructPatchedDocument(engine, {
          id,
          scopeKey,
          branch: resolvedBranch,
          seq: row.seq,
          opIndex: row.op_index,
        });
        document = reconstructed.document;
        weight = reconstructed.encodedBytes;
        break;
      }
      default:
        // `sqlite` ops are never stored as revisions; unreachable.
        throw new Error(`unexpected stored revision op: ${row.op}`);
    }
    cacheDocumentForRevision(engine, cacheKey, { document, weight });
  }

  return {
    id,
    scope: declaredScope,
    scopeKey,
    branch: resolvedBranch,
    seq: row.seq,
    opIndex: row.op_index,
    op: row.op,
    document,
  };
};

/** One stream sidecar doc holding UNDELIVERED events (entries above the
 * stream's `eventWatermark` — or seq-less — and not yet consequenced):
 * the activation/boot discovery input (serving-loop.md §1's "stream head
 * past `eventWatermark` means undelivered events" and §6 step 4's
 * reprocess scan). */
export type PendingStreamEventDoc = {
  id: EntityId;
  scopeKey: string;
  entries: StreamEventEntry[];
  eventWatermark: number;
};

/**
 * Scan the space's stream sidecar docs for undelivered events (Phase 3;
 * serving-loop.md §6 step 4). Cost, stated honestly (review 2026-08-11,
 * n1): the head query is a branch-wide scan filtered by the
 * `of:stream-events:` prefix — under SQLite's default collation a LIKE
 * prefix does NOT use the (branch, id, scope_key) primary key — so the
 * scan is bounded by the branch's HEAD COUNT, with a per-sidecar state
 * read on top. And it is not activation-only: the SpaceServer calls it
 * at activation, per drain, at park evaluation, and at wave-close. If
 * head counts make this hot, the fix is an indexed sidecar registry (or
 * `GLOB`/range bounds that can use the PK), not a comment. Entries at
 * or below the watermark — and consequenced entries above it, which a
 * budget-exhausted wave left durable but processed — are excluded by
 * the idempotency rule (events.md §4).
 */
export const selectPendingStreamEventDocs = (
  engine: Engine,
  options: { branch?: BranchName } = {},
): PendingStreamEventDoc[] => {
  const branch = options.branch ?? DEFAULT_BRANCH;
  const heads = engine.database.prepare(`
SELECT id, scope_key
FROM head
WHERE branch = :branch AND id LIKE :prefix AND op != 'delete'
`).all({
      branch,
      prefix: `${STREAM_ENTRIES_DOC_PREFIX}%`,
    }) as Array<{ id: string; scope_key: string }>;
  const pending: PendingStreamEventDoc[] = [];
  for (const head of heads) {
    const state = readState(engine, {
      id: head.id,
      branch,
      scopeKey: head.scope_key,
    });
    const value = state?.document?.value as StreamEventsDocValue | undefined;
    if (value === undefined) continue;
    const eventWatermark = typeof value.eventWatermark === "number"
      ? value.eventWatermark
      : 0;
    // Defensive (M1/m4, review 2026-08-11): admission refuses authored
    // non-array logs, but a derived writer is trusted — a malformed log
    // must SKIP, never TypeError-wedge activate/park/drain/wave-close.
    const storedEntries = Array.isArray(value.entries) ? value.entries : [];
    const entries = storedEntries.filter((entry) =>
      isObjectOrArray(entry) &&
      typeof entry.eventId === "string" &&
      entry.consequenced !== true &&
      (typeof entry.seq === "number" ? entry.seq > eventWatermark : true)
    );
    if (entries.length === 0) continue;
    pending.push({
      id: head.id,
      scopeKey: head.scope_key,
      entries,
      eventWatermark,
    });
  }
  return pending;
};

/** One retirable effects instance (server-execution v2 Phase 4;
 * protocol.md §5's "the next wave retires acked entries"): the pruned
 * value the SpaceServer's bookkeeping write lands — acked entries
 * removed, their marks with them, stale marks (an ack naming no stored
 * entry) pruned too. */
export type RetirableEffectsInstance = {
  scopeKey: string;

  /** Entries surviving retirement (unacked intents persist — a reload
   * re-reads and may re-enact them, LT8). */
  remainingEntries: EffectIntentEntry[];

  /** Ack marks surviving retirement: acks whose entry still stands
   * (structurally none today — an ack retires its entry — kept exact
   * so the write is a pure prune, never an invention). */
  remainingAcks: Record<string, true>;

  /** The acked nonces this retirement consumes (diagnostics). */
  retiredNonces: string[];
};

/**
 * The retirement scan (Phase 4, protocol.md §5): session-keyed
 * instances of the well-known effects doc whose value holds acked
 * entries — or stale ack marks — to prune. The
 * `selectPendingStreamEventDocs` shape one function up: heads by the
 * exact doc id, `readState` per instance, defensive against malformed
 * values (the ack half is AUTHORED client state — a garbage `acks` or
 * `entries` must skip, never wedge the wave cycle). Non-session
 * instances are skipped: the effects doc is a session-scoped instance
 * by definition (T9), and the retirement writer stamps a session
 * identity parsed from the key.
 */
export const selectRetirableEffectsInstances = (
  engine: Engine,
  options: { branch?: BranchName } = {},
): RetirableEffectsInstance[] => {
  const branch = options.branch ?? DEFAULT_BRANCH;
  const heads = engine.database.prepare(`
SELECT id, scope_key
FROM head
WHERE branch = :branch AND id = :id AND op != 'delete'
`).all({
      branch,
      id: SERVER_EXECUTION_EFFECTS_DOC_ID,
    }) as Array<{ id: string; scope_key: string }>;
  const retirable: RetirableEffectsInstance[] = [];
  for (const head of heads) {
    if (scopeOfScopeKey(head.scope_key) !== "session") continue;
    const state = readState(engine, {
      id: head.id,
      branch,
      scopeKey: head.scope_key,
    });
    const value = state?.document?.value as SessionEffectsDocValue | undefined;
    if (!isObjectOrArray(value)) {
      continue;
    }
    const storedEntries = Array.isArray(value.entries) ? value.entries : [];
    const acks = isObjectNotArray(value.acks)
      ? value.acks as Record<string, unknown>
      : {};
    const ackedNonces = new Set(
      Object.entries(acks)
        .filter(([, marked]) => marked === true)
        .map(([nonce]) => nonce),
    );
    const remainingEntries = storedEntries.filter((entry) =>
      isObjectOrArray(entry) &&
      typeof entry.nonce === "string" && !ackedNonces.has(entry.nonce)
    );
    const remainingNonces = new Set(
      remainingEntries.map((entry) => entry.nonce),
    );
    const remainingAcks: Record<string, true> = {};
    const retiredNonces: string[] = [];
    let staleMarks = false;
    for (const nonce of Object.keys(acks)) {
      if (acks[nonce] !== true) {
        // A malformed mark (not `true`) is pruned as hygiene.
        staleMarks = true;
        continue;
      }
      if (remainingNonces.has(nonce)) {
        remainingAcks[nonce] = true;
      } else if (storedEntries.some((entry) => entry?.nonce === nonce)) {
        retiredNonces.push(nonce);
      } else {
        // An ack naming no stored entry (already retired, or never
        // issued): pruned so marks never accumulate.
        staleMarks = true;
      }
    }
    if (retiredNonces.length === 0 && !staleMarks) continue;
    retirable.push({
      scopeKey: head.scope_key,
      remainingEntries,
      remainingAcks,
      retiredNonces,
    });
  }
  return retirable;
};

export const headSeq = (
  engine: Engine,
  branch: BranchName = DEFAULT_BRANCH,
): number => getBranch(engine, branch)?.headSeq ?? 0;

export const serverSeq = (engine: Engine): number => {
  return (engine.statements.selectServerSeq.get() as { seq: number }).seq;
};

// Event-append admission (server-execution v2 Phase 3, D-v2-1;
// events.md §1, §4; protocol.md §2's event-append rows). ONE stamping
// site with three identity sources — the authenticated envelope for plain
// authored commits, the validated carried actor for delegated ones, and
// (LT1) the already-written inherited actor for derived wave carriage,
// where producer and admitter are one trust environment and only the
// entry's stream `seq` needs stamping.

/** Where one declared appended entry sits inside the commit's operations,
 * plus the `firedAt` admission resolved for it. The stamp step clones the
 * op (the caller's operation objects are shared with replica overlays —
 * wave batches hold the sealed commits' own arrays) and writes `seq` +
 * `firedAt` into the clone only. */
type EventAppendStamp = {
  opIndex: number;

  /** Index into the op's `patches` array; absent for a whole-doc `set`. */
  patchIndex?: number;

  /** Index into the patch's `values` array (append/add-unique) or the
   * written array value (add/replace/set). */
  valueIndex: number;

  firedAt: StreamEventFiredAt;
};

const isStreamEntriesDocId = (id: string): boolean =>
  id.startsWith(STREAM_ENTRIES_DOC_PREFIX);

const STREAM_ENTRIES_POINTER = "/value/entries";

/** The entry arrays a patch WRITES into `/value/entries`, with locations.
 * Returns null when the patch touches the sidecar doc some OTHER way —
 * the caller refuses those for non-derived classes. */
const appendedEntriesOfPatch = (
  patch: PatchOp,
): { values: unknown[]; creation: boolean } | null => {
  if (patch.op === "append" || patch.op === "add-unique") {
    if (patch.path !== STREAM_ENTRIES_POINTER) return null;
    return { values: patch.values as unknown[], creation: false };
  }
  if (patch.op === "add" || patch.op === "replace") {
    if (patch.path !== STREAM_ENTRIES_POINTER) return null;
    return {
      values: Array.isArray(patch.value) ? (patch.value as unknown[]) : [],
      creation: true,
    };
  }
  return null;
};

const entryFiredAtMatches = (
  supplied: StreamEventFiredAt,
  stamp: StreamEventFiredAt,
): boolean =>
  (supplied.user === undefined || supplied.user === stamp.user) &&
  (supplied.session === undefined || supplied.session === stamp.session);

/**
 * The prefix-keyed sidecar SHAPE guard (independent review 2026-08-11,
 * M1+m4). Runs for AUTHORED commits REGARDLESS of the server-execution
 * flag, before the flag early-return:
 *
 * - Flag ON: a non-array write at `/value/entries` of a stream sidecar
 *   doc is REFUSED in BOTH admission arms. Pre-guard, the arms coerced
 *   a non-array to `[]` for validation while the write applied
 *   verbatim — the commit ADMITTED with zero located entries, then
 *   `selectPendingStreamEventDocs` TypeErrored over the non-array in
 *   activate/park/drain/wave-close (wedging the space) and every
 *   honest append hit the garbage in its dedupe read.
 * - Flag OFF (m4): authored writes into `of:stream-events:`-prefixed
 *   docs are refused OUTRIGHT. The OFF arm has no event-append
 *   admission at all, so OFF-written garbage — a non-array log, or a
 *   well-formed entry carrying a forged `firedAt` actor no admission
 *   ever validated — would sit durable and poison the FIRST ON
 *   activation. This is a recorded OFF-arm acceptance (writes that
 *   formerly succeeded now refuse): defect-flavored freedom removed;
 *   see verification-coverage.md's recorded-acceptance row (RATIFIED
 *   2026-08-13, both deltas — coordinator-adjudicated 2026-08-11).
 *
 * Derived commits stay exempt (one trust environment — the
 * SpaceServer's own serialization); the pending scan and the watermark
 * recompute carry defensive `Array.isArray` guards so even a
 * derived-written malformed log can never wedge the engine.
 */
const refuseMalformedAuthoredStreamWrites = (
  commit: ClientCommit,
  commitClass: CommitClass,
  flagOn: boolean,
): void => {
  if (commitClass !== "authored") return;
  const nonArray = (id: string): ProtocolError =>
    new ProtocolError(
      `authored write into stream doc "${id}" carries a non-array ` +
        `"${STREAM_ENTRIES_POINTER}" value — the entries log is an ` +
        "ARRAY of entries; a non-array log would wedge the pending " +
        "scan (events.md §1, §4)",
    );
  for (const operation of commit.operations) {
    if (operation.op === "sqlite") continue;
    if (!isStreamEntriesDocId(operation.id)) continue;
    if (!flagOn) {
      throw new ProtocolError(
        `authored write into stream doc "${operation.id}" refused: ` +
          "stream sidecar docs require EXPERIMENTAL_SERVER_EXECUTION — " +
          "the OFF arm has no event-append admission, and OFF-written " +
          "state (unvalidated shapes, unstamped firedAt actors) would " +
          "poison the first ON activation (events.md §1, §4)",
      );
    }
    if (operation.op === "delete") continue;
    if (operation.op === "set") {
      const value = operation.value?.value;
      if (
        isObjectOrArray(value) &&
        "entries" in (value as Record<string, unknown>) &&
        !Array.isArray((value as { entries?: unknown }).entries)
      ) {
        throw nonArray(operation.id);
      }
      continue;
    }
    if (operation.op !== "patch") continue;
    for (const patch of operation.patches) {
      if (patch.path !== STREAM_ENTRIES_POINTER) continue;
      if (
        (patch.op === "add" || patch.op === "replace") &&
        !Array.isArray(patch.value)
      ) {
        throw nonArray(operation.id);
      }
      if (
        (patch.op === "append" || patch.op === "add-unique") &&
        !Array.isArray(patch.values)
      ) {
        throw nonArray(operation.id);
      }
    }
  }
};

/**
 * Refuses authored-class mutations of the server-owned attention index.
 * Terminal-cover commits and resolution transactions maintain this discovery
 * hint together with the authoritative stream entry.
 */
const refuseAuthoredAttentionIndexWrites = (
  commit: ClientCommit,
  commitClass: CommitClass,
): void => {
  if (commitClass !== "authored") return;
  for (const operation of commit.operations) {
    if (
      operation.op !== "sqlite" &&
      operation.id === SERVER_EXECUTION_ATTENTION_DOC_ID
    ) {
      throw new ProtocolError(
        `authored write to server-owned attention index ` +
          `"${SERVER_EXECUTION_ATTENTION_DOC_ID}" refused`,
      );
    }
  }
};

/**
 * Validate the commit's declared event appends against events.md §1/§4 and
 * resolve the stamp plan. Runs INSIDE the apply transaction, before the
 * commit seq is allocated; the returned plan is applied per-op in the
 * write loop (each stamped op is a CLONE — caller-shared operation objects
 * are never mutated). Throws {@link ProtocolError} on shape/identity
 * violations and {@link EventAppendDuplicateError} on the dedupe-horizon
 * CAS (events.md §4: uniqueness among entries above the stream's
 * `eventWatermark`; the stage-G seq-less interim arm dedupes only while
 * un-consequenced, so it retires as processing marks entries).
 */
const validateEventAppends = (
  engine: Engine,
  args: {
    commit: ClientCommit;
    commitClass: CommitClass;
    branch: BranchName;
    principal?: string;
    sessionId: SessionId;
    delegated?: NonNullable<ApplyCommitOptions["delegated"]>;
    systemEventActor?: NonNullable<ApplyCommitOptions["systemEventActor"]>;

    /** Derived-class scoped-op keys (the annotation ADDRESSING), for the
     * dedupe read of scoped sidecars. */
    scopeKeyByOpIndex: ReadonlyMap<number, string>;
  },
): Map<number, EventAppendStamp[]> => {
  const {
    commit,
    commitClass,
    branch,
    principal,
    sessionId,
    delegated,
    systemEventActor,
  } = args;
  const decls = commit.eventAppends ?? [];
  const plan = new Map<number, EventAppendStamp[]>();
  const flagOn = getServerExecutionConfig();
  if (decls.length > 0 && !flagOn) {
    throw new ProtocolError(
      "event appends require EXPERIMENTAL_SERVER_EXECUTION " +
        "(events.md §1; the OFF arm has no event-append admission)",
    );
  }
  // The prefix-keyed shape guard runs in BOTH flag arms (M1+m4,
  // review 2026-08-11) — see its doc comment.
  refuseMalformedAuthoredStreamWrites(commit, commitClass, flagOn);
  refuseAuthoredAttentionIndexWrites(commit, commitClass);
  if (!flagOn) return plan;

  // Declarations index — one per (doc-instance, eventId); duplicates in
  // one commit are a self-collision, refused before any store read.
  const declKey = (id: string, scope: CellScope | undefined, eventId: string) =>
    `${id}\0${normalizeScope(scope)}\0${eventId}`;
  const unmatched = new Map<string, EventAppendDecl>();
  for (const decl of decls) {
    if (!isStreamEntriesDocId(decl.id)) {
      throw new ProtocolError(
        `event-append declaration targets a non-stream doc "${decl.id}" ` +
          "(events.md §1: an event is an append to a stream document — " +
          `the "${STREAM_ENTRIES_DOC_PREFIX}" sidecar)`,
      );
    }
    const key = declKey(decl.id, decl.scope, decl.eventId);
    if (unmatched.has(key)) {
      throw new ProtocolError(
        `duplicate event-append declaration for eventId ${decl.eventId} ` +
          "in one commit (events.md §4)",
      );
    }
    unmatched.set(key, decl);
  }

  for (const [opIndex, operation] of commit.operations.entries()) {
    if (operation.op === "sqlite") continue;
    if (!isStreamEntriesDocId(operation.id)) continue;

    // The sidecar-doc write guard (the stamping claim's other half —
    // events.md §1's "a forged actor is UNREPRESENTABLE"): processing
    // fields (`consequenced`/`error`/`status`/`reason` plus OW54's delivery
    // checkpoint, attention, resolution, and retry provenance), the per-stream
    // `eventWatermark`, and stored entries are SERVER-written state.
    // Authored traffic (delegated included) may reach a sidecar doc ONLY
    // as declared tail appends; anything else — deeper patches, watermark
    // writes, whole-array rewrites of an existing log, deletes — is
    // refused. Derived commits are exempt from the SHAPE restriction (one
    // trust environment: the SpaceServer writes consequences and the
    // watermark) but their appended entries must still be DECLARED, so
    // seq stamping cannot be skipped by a plumbing bug. System commits are
    // likewise trusted for OW54's atomic resolution and Retry append.
    const authoredShape = commitClass === "authored";

    // One current-state read per op: the derived REWRITE check and the
    // dedupe-horizon CAS below both judge against the stored log.
    const currentState = readState(engine, {
      id: operation.id,
      branch,
      scope: operation.scope,
      principal: delegated?.actingPrincipal ?? principal,
      sessionId: delegated?.actingSession ?? sessionId,
      scopeKey: args.scopeKeyByOpIndex.get(opIndex),
    });
    const currentValue = currentState?.document?.value as
      | StreamEventsDocValue
      | undefined;
    // Defensive Array.isArray (M1/m4, review 2026-08-11): an honest
    // append judged against a malformed stored log must refuse/skip
    // cleanly, never TypeError into the transient-retry-forever class.
    const storedEntries = Array.isArray(currentValue?.entries)
      ? currentValue!.entries!
      : [];

    // A terminal notice is the only durable recovery handle on its stream.
    // A derived compaction or server-owned rewrite may remove it only after a
    // resolution is already recorded. Judge the final operation value, not
    // the patch vocabulary, so whole-document, whole-array, splice, and
    // element-level rewrites all share one retention rule.
    const unresolvedAttentionEntries = storedEntries.filter((entry) =>
      entry?.status === "needs-attention" &&
      entry.attention !== undefined && entry.resolution === undefined
    );
    if (commitClass !== "authored" && unresolvedAttentionEntries.length > 0) {
      if (operation.op === "delete") {
        throw new ProtocolError(
          `stream doc "${operation.id}" cannot remove unresolved ` +
            "needs-attention entries (events.md §4)",
        );
      }
      if (operation.op !== "set" && operation.op !== "patch") {
        throw new ProtocolError(
          `stream doc "${operation.id}" cannot apply or release operation ` +
            "fields while it holds unresolved needs-attention entries " +
            "(events.md §4)",
        );
      }
      const resultingDocument = operation.op === "set"
        ? operation.value
        : applyPatchToDocument(
          currentState?.document ?? undefined,
          operation.patches,
        );
      const resultingValue = resultingDocument?.value as
        | StreamEventsDocValue
        | undefined;
      const resultingEntries = Array.isArray(resultingValue?.entries)
        ? resultingValue.entries
        : [];
      for (const unresolved of unresolvedAttentionEntries) {
        const resulting = resultingEntries.find((entry) =>
          entry?.eventId === unresolved.eventId && entry.seq === unresolved.seq
        );
        const retained = resulting !== undefined &&
          sameEventEntryExceptResolution(unresolved, resulting) &&
          (resulting.resolution === undefined ||
            (commitClass === "system" &&
              isEventAttentionResolution(resulting.resolution)));
        if (!retained) {
          throw new ProtocolError(
            `stream doc "${operation.id}" cannot alter or compact unresolved ` +
              `needs-attention event ${unresolved.eventId} ` +
              "(events.md §4)",
          );
        }
      }
    }

    const located: Array<{
      entry: StreamEventEntry;
      stamp: Omit<EventAppendStamp, "firedAt">;
    }> = [];
    if (operation.op === "delete") {
      if (authoredShape) {
        throw new ProtocolError(
          `authored deletion of stream doc "${operation.id}" refused ` +
            "(events.md §4: compaction is the serving side's, below the " +
            "watermark only)",
        );
      }
      continue;
    }
    if (operation.op === "set") {
      const value = (operation.value?.value ?? {}) as StreamEventsDocValue;
      const entries = Array.isArray(value.entries) ? value.entries : [];
      if (authoredShape) {
        if (currentState !== null && currentState.document !== null) {
          throw new ProtocolError(
            `authored whole-doc set of existing stream doc ` +
              `"${operation.id}" refused — append entries with a ` +
              "declared tail append (events.md §1)",
          );
        }
        const extraKeys = Object.keys(operation.value?.value ?? {}).filter(
          (key) => key !== "entries",
        );
        if (extraKeys.length > 0) {
          throw new ProtocolError(
            `authored stream-doc creation carries non-entry fields ` +
              `(${extraKeys.join(", ")}) — the watermark and processing ` +
              "state are server-written (events.md §4, §5)",
          );
        }
      }
      for (const [valueIndex, entry] of entries.entries()) {
        located.push({
          entry: entry as StreamEventEntry,
          stamp: { opIndex, valueIndex },
        });
      }
    } else {
      if (operation.op !== "patch") continue;
      for (const [patchIndex, patch] of operation.patches.entries()) {
        const appended = appendedEntriesOfPatch(patch);
        if (appended === null) {
          if (authoredShape) {
            throw new ProtocolError(
              `authored write into stream doc "${operation.id}" at ` +
                `"${patch.path}" refused — entries, the watermark, and ` +
                "processing fields are server-written; events append " +
                "via declared tail appends only (events.md §1, §4, §5)",
            );
          }
          continue;
        }
        if (appended.creation && authoredShape) {
          if (storedEntries.length > 0) {
            throw new ProtocolError(
              `authored whole-array write of stream doc ` +
                `"${operation.id}" entries refused — the log already ` +
                "holds entries; append via tail appends (events.md §1)",
            );
          }
        }
        for (const [valueIndex, entry] of appended.values.entries()) {
          located.push({
            entry: entry as StreamEventEntry,
            stamp: { opIndex, patchIndex, valueIndex },
          });
        }
      }
    }

    for (const { entry, stamp } of located) {
      if (!isObjectOrArray(entry)) {
        throw new ProtocolError(
          `stream doc "${operation.id}" appended a non-entry value ` +
            "(events.md §1)",
        );
      }
      if (typeof entry.eventId !== "string" || entry.eventId === "") {
        throw new ProtocolError(
          `stream doc "${operation.id}" appended an entry without an ` +
            "eventId (events.md §1)",
        );
      }
      // The derived REWRITE arm: the SpaceServer's consequence marking,
      // per-stream `eventWatermark` companion writes, and §4 compaction
      // all re-write ALREADY-STAMPED entries (a wave's final-value set
      // of a sidecar doc necessarily carries the whole log). An entry
      // whose (eventId, seq) matches a STORED entry is such a rewrite —
      // no declaration, no stamping, no CAS (its admission happened when
      // it was appended). A seq-BEARING entry matching nothing stored is
      // a forgery and is refused: seqs are engine-stamped, never minted
      // by any producer (events.md §4).
      if (commitClass === "derived" && entry.seq !== undefined) {
        const matches = storedEntries.some((stored) =>
          stored?.eventId === entry.eventId && stored.seq === entry.seq
        );
        if (!matches) {
          throw new ProtocolError(
            `derived rewrite of stream entry ${entry.eventId} names a ` +
              `seq (${entry.seq}) no stored entry holds — entry seqs ` +
              "are engine-stamped, never producer-minted (events.md §4)",
          );
        }
        continue;
      }
      const key = declKey(operation.id, operation.scope, entry.eventId);
      const decl = unmatched.get(key);
      if (decl === undefined) {
        throw new ProtocolError(
          `undeclared event append (eventId ${entry.eventId}) into ` +
            `stream doc "${operation.id}" — every appended entry needs ` +
            "its declaration for admission to stamp (events.md §1; " +
            "protocol.md §2)",
        );
      }
      unmatched.delete(key);
      // Processing-side and engine-stamped fields must arrive ABSENT on
      // authored traffic: a pre-supplied seq forges ordering, a
      // pre-supplied consequenced/error/status forges the processing
      // outcome. DERIVED new appends are exempt from the processing-field
      // half: a same-wave-processed emitted event legitimately commits
      // its entry together with its consequences — already
      // `consequenced` (or errored) at birth (events.md §2's LT1
      // carriage, §5) — and one trust environment writes both.
      if (entry.seq !== undefined) {
        throw new ProtocolError(
          `event append ${entry.eventId} pre-supplies the stream seq — ` +
            "engine-stamped at apply (events.md §4)",
        );
      }
      if (
        commitClass === "authored" &&
        (entry.consequenced !== undefined || entry.error !== undefined ||
          entry.status !== undefined || entry.reason !== undefined ||
          entry.deliveryDeferral !== undefined ||
          entry.attention !== undefined || entry.resolution !== undefined ||
          entry.retryOf !== undefined ||
          entry.deliveryFailures !== undefined)
      ) {
        throw new ProtocolError(
          `event append ${entry.eventId} pre-supplies processing fields ` +
            "— the SpaceServer writes consequences (events.md §5)",
        );
      }
      if (
        !isObjectOrArray(entry.stream) ||
        typeof entry.stream.id !== "string" ||
        !Array.isArray(entry.stream.path)
      ) {
        throw new ProtocolError(
          `event append ${entry.eventId} carries no stream link — ` +
            "entries are self-describing (events.md §1)",
        );
      }
      // The link must DERIVE the sidecar being written (events.md §1:
      // the sidecar id is the hash every party derives from the stream
      // link with no coordination). Without this binding, an append
      // into a FRESH sidecar id can name ANOTHER stream in its
      // self-describing link: the drain executes the named stream's
      // handler while the eventId only ever met the fresh doc's empty
      // dedupe horizon — a per-stream exactly-once bypass (verdict
      // blocker, 2026-08-12). Derived REWRITES of already-stamped
      // entries never reach here (their admission happened at append).
      if (streamEntriesDocId(entry.stream as StreamLinkRef) !== operation.id) {
        throw new ProtocolError(
          `event append ${entry.eventId} carries a stream link that ` +
            `does not derive the sidecar doc being written ` +
            `("${operation.id}") — the self-describing link and the ` +
            "sidecar id are one derivation (events.md §1)",
        );
      }
      // A PRESENT runtimeInjectedEventKeys must be a string array
      // (verdict blocker, 2026-08-12): the drain re-mints the carried
      // keys per entry, and a persisted malformed value would throw
      // there on EVERY scan pass — perpetual serving churn from one
      // poisoned entry. Refused at the door instead.
      if (
        entry.runtimeInjectedEventKeys !== undefined &&
        (!Array.isArray(entry.runtimeInjectedEventKeys) ||
          entry.runtimeInjectedEventKeys.some((key) => typeof key !== "string"))
      ) {
        throw new ProtocolError(
          `event append ${entry.eventId} carries malformed ` +
            "runtimeInjectedEventKeys — a present value must be an " +
            "array of strings (events.md §1's entry shape)",
        );
      }
      // The renderer-trust attestation (fan-out stage B, the sister of
      // the keys above): a present value must be exactly `true` — the
      // drain re-marks on it, and a malformed value would be judged on
      // every scan pass. Refused at the door instead.
      if (
        (entry as { rendererTrusted?: unknown }).rendererTrusted !==
          undefined &&
        (entry as { rendererTrusted?: unknown }).rendererTrusted !== true
      ) {
        throw new ProtocolError(
          `event append ${entry.eventId} carries malformed ` +
            "rendererTrusted — a present value must be true (events.md " +
            "§1's entry shape)",
        );
      }

      // The firedAt stamp, per admitting class (protocol.md §2).
      let firedAt: StreamEventFiredAt;
      if (commitClass === "derived") {
        // LT1 same-space carriage: the SpaceServer wrote the inherited
        // actor; producer and admitter are one trust environment, so the
        // stamp needs no validation (events.md §2) — but it must EXIST,
        // and it never carries a clientSeq (LT7).
        const supplied = entry.firedAt;
        if (
          supplied === undefined || typeof supplied.session !== "string" ||
          supplied.session === ""
        ) {
          throw new ProtocolError(
            `derived-carried event append ${entry.eventId} carries no ` +
              "inherited firedAt (events.md §2, LT1)",
          );
        }
        if (supplied.clientSeq !== undefined) {
          throw new ProtocolError(
            `server-originated event append ${entry.eventId} carries a ` +
              "clientSeq — client-minted only (events.md §2, LT7)",
          );
        }
        firedAt = supplied;
      } else if (systemEventActor !== undefined) {
        if (entry.retryOf === undefined || entry.retryOf === "") {
          throw new ProtocolError(
            `system-attributed event append ${entry.eventId} carries no ` +
              "retryOf provenance (events.md §5)",
          );
        }
        firedAt = {
          user: systemEventActor.principal,
          session: systemEventActor.sessionId,
        };
        if (entry.firedAt?.clientSeq !== undefined) {
          throw new ProtocolError(
            `system-attributed event append ${entry.eventId} carries a ` +
              "clientSeq — client-minted only (events.md §2, LT7)",
          );
        }
        if (
          entry.firedAt !== undefined &&
          !entryFiredAtMatches(entry.firedAt, firedAt)
        ) {
          throw new ProtocolError(
            `event append ${entry.eventId} supplies a firedAt that ` +
              "disagrees with the authenticated Retry actor — REJECTED, " +
              "never corrected (events.md §5)",
          );
        }
      } else if (delegated !== undefined) {
        const userless = delegated.actingPrincipal === undefined ||
          delegated.actingPrincipal === "";
        firedAt = {
          ...(userless ? {} : { user: delegated.actingPrincipal }),
          session: delegated.actingSession === undefined ||
              delegated.actingSession === ""
            ? "server"
            : delegated.actingSession,
        };
        if (entry.firedAt?.clientSeq !== undefined) {
          throw new ProtocolError(
            `delegated event append ${entry.eventId} carries a ` +
              "clientSeq — client-minted only (events.md §2, LT7)",
          );
        }
        if (
          entry.firedAt !== undefined &&
          !entryFiredAtMatches(entry.firedAt, firedAt)
        ) {
          throw new ProtocolError(
            `event append ${entry.eventId} supplies a firedAt that ` +
              "disagrees with the validated carried actor — REJECTED, " +
              "never corrected (events.md §1, protocol.md §2)",
          );
        }
      } else {
        if (principal === undefined || principal === "") {
          throw new ProtocolError(
            `event append ${entry.eventId} requires an authenticated ` +
              "principal to stamp firedAt from (events.md §1)",
          );
        }
        firedAt = {
          user: principal,
          session: sessionId,
          ...(entry.firedAt?.clientSeq !== undefined
            ? { clientSeq: entry.firedAt.clientSeq }
            : {}),
        };
        if (
          entry.firedAt !== undefined &&
          !entryFiredAtMatches(entry.firedAt, firedAt)
        ) {
          throw new ProtocolError(
            `event append ${entry.eventId} supplies a firedAt that ` +
              "disagrees with the authenticated envelope — REJECTED, " +
              "never corrected (events.md §1, protocol.md §2)",
          );
        }
      }

      // The dedupe-horizon CAS (events.md §4): eventId unique among
      // entries above the stream's eventWatermark. A seq-less entry (the
      // stage-G interim arm) dedupes only while un-consequenced — it
      // retires as processing marks it, never forever (the stage-G
      // obligation comment in server.ts, discharged here). Judged
      // against the per-op current-state read above.
      const horizon = typeof currentValue?.eventWatermark === "number"
        ? currentValue.eventWatermark
        : 0;
      const duplicate = storedEntries.some((existing) =>
        existing?.eventId === entry.eventId &&
        (typeof existing.seq === "number"
          ? existing.seq > horizon
          : existing.consequenced !== true)
      );
      if (duplicate) {
        throw new EventAppendDuplicateError(
          `event append ${entry.eventId} duplicates a stream entry ` +
            "above the dedupe horizon (events.md §4)",
        );
      }

      const stamps = plan.get(stamp.opIndex) ?? [];
      stamps.push({ ...stamp, firedAt });
      plan.set(stamp.opIndex, stamps);
    }
  }

  if (unmatched.size > 0) {
    const missing = [...unmatched.values()].map((decl) => decl.eventId);
    throw new ProtocolError(
      `event-append declaration(s) without a matching appended entry: ` +
        `${missing.join(", ")} (events.md §1)`,
    );
  }
  return plan;
};

/** A fresh entry list whose OBJECT entries are shallow-copied — the
 * stamping writes (seq, firedAt) land on the copies; every deeper value
 * (payload included) stays SHARED by reference. */
const spineCloneEntryList = (entries: readonly unknown[]): unknown[] =>
  entries.map((entry) =>
    isObjectNotArray(entry) ? { ...(entry as Record<string, unknown>) } : entry
  );

/** Clone exactly the SPINE the stamping mutates: the operation object,
 * the containers down to `/value/entries`, and the entry objects
 * themselves. NEVER `structuredClone` (verdict blocker, 2026-08-12):
 * the co-hosted wave sink hands this path the runner's own op objects,
 * whose FabricValue payloads can carry registry symbols —
 * `structuredClone` throws `DataCloneError` on those and demotes
 * fabric classes it can copy. Payload values are never mutated here,
 * so sharing them is sound. */
const spineCloneSidecarOperation = <
  Op extends Exclude<Operation, SqliteOperation>,
>(operation: Op): Op => {
  if (operation.op === "set") {
    const outer = (operation.value ?? undefined) as
      | Record<string, unknown>
      | undefined;
    const inner = (outer?.value ?? undefined) as
      | Record<string, unknown>
      | undefined;
    if (inner === undefined || !Array.isArray(inner.entries)) {
      return { ...operation };
    }
    return {
      ...operation,
      value: {
        ...outer,
        value: { ...inner, entries: spineCloneEntryList(inner.entries) },
      },
    } as Op;
  }
  if (operation.op === "patch") {
    return {
      ...operation,
      patches: operation.patches.map((patch) => {
        if (
          (patch.op === "append" || patch.op === "add-unique") &&
          patch.path === STREAM_ENTRIES_POINTER
        ) {
          return {
            ...patch,
            values: spineCloneEntryList(patch.values as unknown[]) as never,
          };
        }
        if (
          (patch.op === "add" || patch.op === "replace") &&
          patch.path === STREAM_ENTRIES_POINTER &&
          Array.isArray((patch as unknown as { value?: unknown }).value)
        ) {
          return {
            ...patch,
            value: spineCloneEntryList(
              (patch as unknown as { value: unknown[] }).value,
            ) as never,
          };
        }
        return patch;
      }),
    } as Op;
  }
  return { ...operation };
};

/** Apply one op's stamp plan onto a CLONE (the input operation object is
 * shared with replica overlays and must never be mutated). */
const stampEventAppendOperation = <
  Op extends Exclude<Operation, SqliteOperation>,
>(
  operation: Op,
  stamps: readonly EventAppendStamp[],
  seq: number,
): Op => {
  const cloned = spineCloneSidecarOperation(operation);
  for (const stamp of stamps) {
    let entry: StreamEventEntry | undefined;
    if (cloned.op === "set") {
      const value = (cloned.value?.value ?? {}) as StreamEventsDocValue;
      entry = value.entries?.[stamp.valueIndex];
    } else if (cloned.op === "patch" && stamp.patchIndex !== undefined) {
      const patch = cloned.patches[stamp.patchIndex];
      const appended = appendedEntriesOfPatch(patch);
      entry = appended?.values[stamp.valueIndex] as
        | StreamEventEntry
        | undefined;
    }
    if (entry === undefined) {
      throw new ProtocolError(
        "event-append stamp plan does not match the operation shape " +
          "(engine bug — the plan and the clone diverged)",
      );
    }
    entry.seq = seq;
    entry.firedAt = stamp.firedAt;
  }
  return cloned;
};

/** An effect-intent-shaped entry (protocol.md §5's `{nonce, kind, args,
 * issuedIn}`). */
const isEffectIntentShaped = (
  value: unknown,
): value is EffectIntentEntry =>
  isObjectOrArray(value) &&
  typeof (value as EffectIntentEntry).nonce === "string" &&
  (value as EffectIntentEntry).kind === "navigate";

/** An intent entry awaiting its `issuedIn` stamp (the `null` sentinel —
 * protocol.md §5's `issuedIn: <derived commit seq>`, written by the
 * producer before the wave's seq exists). */
const isUnstampedEffectIntent = (
  value: unknown,
): value is EffectIntentEntry & { issuedIn: null } =>
  isEffectIntentShaped(value) && value.issuedIn === null;

/**
 * Transform a DERIVED-class write of the well-known effects doc at apply
 * time (server-execution v2 Phase 4; protocol.md §5). Two duties, both
 * on a CLONE (the input operation object is shared with replica overlays
 * and must never be mutated):
 *
 * - **`issuedIn` stamping** — the stream-entry `seq` precedent one
 *   function up: the producing wave writes the `null` sentinel (the
 *   commit seq is allocated only here) and the engine stamps it. Keyed
 *   by the WELL-KNOWN doc id (the id is the declaration — a producer
 *   cannot forget it); derived-class only — an authored write carrying
 *   the sentinel (a client authoring into its own instance,
 *   protocol.md §1's accepted intrusion class) is stored as-is.
 *
 * - **nonce dedupe on APPEND-shaped patches** — an appended intent whose
 *   nonce already exists in the STORED instance value is dropped from
 *   the append: the nonce is deterministic per (event × navigateTo
 *   instance), so a re-run of the producing action (a wave retry, an
 *   event requeue, a server restart re-demand) re-appends the same
 *   nonce, and the store — not the serving replica's scope-name-keyed
 *   local view, which collapses instances at cardinality > 1 (the OW17
 *   residual) — is the idempotency authority. Whole-value SETs are
 *   deliberately EXEMPT from dedupe: the retirement write (the
 *   bookkeeping-stamped prune, serving-loop.md §3d) rewrites surviving
 *   entries as a whole value, and deduping those against themselves
 *   would empty every retirement.
 */
const transformEffectsDocOperation = <
  Op extends Exclude<Operation, SqliteOperation>,
>(
  engine: Engine,
  operation: Op,
  seq: number,
  keys: { branch: BranchName; scopeKey: string | undefined },
): Op => {
  const hasIntent = (value: unknown, depth: number): boolean => {
    if (depth > 8 || !isObjectOrArray(value)) return false;
    if (isEffectIntentShaped(value)) return true;
    if (Array.isArray(value)) {
      return value.some((item) => hasIntent(item, depth + 1));
    }
    return Object.values(value).some((item) => hasIntent(item, depth + 1));
  };
  const probe = operation.op === "set"
    ? hasIntent(operation.value?.value, 0)
    : operation.op === "patch"
    ? operation.patches.some((patch) =>
      hasIntent((patch as { value?: unknown }).value, 0) ||
      hasIntent((patch as { values?: unknown }).values, 0)
    )
    : false;
  if (!probe) return operation;

  // The stored instance's nonce set — the dedupe basis. Read per
  // instance via the annotation-supplied scope key (the same override
  // writeOperation applies below). Defensive: a scoped op with no
  // resolvable key skips dedupe (stamping still applies) rather than
  // throwing here — the scoped-write admission checks own that refusal.
  const storedNonces = new Set<string>();
  try {
    const state = readState(engine, {
      id: operation.id,
      branch: keys.branch,
      scope: operation.scope,
      scopeKey: keys.scopeKey,
    });
    const storedValue = state?.document?.value as
      | SessionEffectsDocValue
      | undefined;
    if (isObjectOrArray(storedValue)) {
      const entries = Array.isArray(storedValue?.entries)
        ? storedValue.entries
        : [];
      for (const entry of entries) {
        if (isEffectIntentShaped(entry)) storedNonces.add(entry.nonce);
      }
    }
  } catch {
    // no resolvable instance — dedupe is best-effort; stamping proceeds
  }

  const cloned = structuredClone(operation) as Op;
  const stamp = (value: unknown, depth: number): void => {
    if (depth > 8 || !isObjectOrArray(value)) return;
    if (isUnstampedEffectIntent(value)) {
      (value as { issuedIn: number | null }).issuedIn = seq;
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) stamp(item, depth + 1);
      return;
    }
    for (const item of Object.values(value)) stamp(item, depth + 1);
  };
  if (cloned.op === "set") {
    stamp(cloned.value?.value, 0);
  } else if (cloned.op === "patch") {
    for (const patch of cloned.patches) {
      if (
        (patch.op === "append" || patch.op === "add-unique") &&
        Array.isArray(patch.values)
      ) {
        // Dedupe the APPEND against the stored instance, then stamp the
        // survivors.
        patch.values = patch.values.filter((item) =>
          !(isEffectIntentShaped(item) && storedNonces.has(item.nonce))
        );
        stamp(patch.values, 0);
        continue;
      }
      stamp((patch as { value?: unknown }).value, 0);
      stamp((patch as { values?: unknown }).values, 0);
    }
  }
  return cloned;
};

export const applyCommit = (
  engine: Engine,
  options: ApplyCommitOptions,
): AppliedCommit => runAtomicCommit(engine, (apply) => apply(options));

/**
 * Serializes private service metadata with ordinary engine commits. The callback
 * reads the latest store under the write lock; decoded revisions become visible
 * in the cache only after the entire transaction commits durably.
 */
export const runAtomicCommit = <T>(
  engine: Engine,
  operation: (apply: (options: ApplyCommitOptions) => AppliedCommit) => T,
  options: { durable?: boolean } = {},
): T => {
  if (engine.database.inTransaction) {
    throw new ProtocolError(
      "atomic service operations cannot nest transactions",
    );
  }
  // A commit reads its own uncommitted rows — snapshot materialization asks
  // for the state it has just written — and those reads are worth keeping,
  // being of the revisions everything is about to ask for. They are held aside
  // until the rows behind them are durable: a transaction that throws rolls
  // SQLite back, and an entry recorded from what it wrote would describe a
  // revision that never happened. A retry then writes its own revision at the
  // sequence and operation index the rolled-back one had.
  const previousSync = options.durable
    ? engine.database.prepare("PRAGMA synchronous").get<
      { synchronous: number }
    >()!.synchronous
    : undefined;
  if (previousSync !== undefined) {
    engine.database.exec("PRAGMA synchronous = FULL");
  }
  const staged = new Map<string, DocumentCacheEntry>();
  engine.stagedDocumentCache = staged;
  try {
    const applied = engine.database.transaction(() =>
      operation((options) => applyCommitTransaction(engine, options))
    ).immediate();
    // Durable now, so what was read from those rows can be remembered. A
    // revision the cache already holds was served from it rather than
    // staged, so a present key here is not expected; skipping it keeps the
    // byte accounting exact if that ever changes.
    engine.stagedDocumentCache = undefined;
    for (const [key, entry] of staged) {
      if (!engine.documentCache.has(key)) {
        cacheDocumentForRevision(engine, key, entry);
      }
    }
    return applied;
  } finally {
    // Also the rollback path, where `staged` is dropped unread.
    engine.stagedDocumentCache = undefined;
    if (previousSync !== undefined) {
      engine.database.exec(`PRAGMA synchronous = ${previousSync}`);
    }
  }
};

/**
 * A wave commit's per-doc CAS re-verification failed: some doc the batch
 * writes has a head past the wave's basis, or a rebased doc's head moved
 * past the head the rebase decision observed. The wave commit step folds
 * `conflictedDocs` into its conflict resolution and re-attempts —
 * whole-wave CAS failure is forbidden (serving-loop.md §3d), so this
 * error NAMES what moved.
 */
export class WaveCommitConflictError extends Error {
  override readonly name = "WaveCommitConflictError";
  readonly conflictedDocs: readonly string[];
  constructor(conflictedDocs: readonly string[]) {
    super(
      `wave commit re-verification: doc head(s) advanced past the wave ` +
        `basis: ${conflictedDocs.join(", ")}`,
    );
    this.conflictedDocs = conflictedDocs;
  }
}

/**
 * A wave commit's precondition pre-check failed. Unlike the shared
 * validator's first-failure throw, this NAMES every failing precondition
 * by index into the batch's preconditions array, so the wave commit step
 * can resolve each failure to its owning contribution per write class
 * (serving-loop.md §3d — one contribution's violated create-only mark
 * must not abort every other contribution's work).
 */
export class WavePreconditionError extends Error {
  override readonly name = "WavePreconditionError";
  readonly failedPreconditions: readonly number[];
  constructor(failedPreconditions: readonly number[], detail: string) {
    super(
      `wave commit precondition(s) failed at index(es) ` +
        `${failedPreconditions.join(", ")}: ${detail}`,
    );
    this.failedPreconditions = failedPreconditions;
  }
}

/** Current head seq of one doc instance (0 when never written). */
export const selectDocHead = (
  engine: Engine,
  options: { branch?: BranchName; id: EntityId; scopeKey: string },
): number => {
  const row = engine.database.prepare(`
SELECT seq FROM head
WHERE branch = :branch AND id = :id AND scope_key = :scope_key
`).get({
      branch: options.branch ?? DEFAULT_BRANCH,
      id: options.id,
      scope_key: options.scopeKey,
    }) as { seq: number } | undefined;
  return row?.seq ?? 0;
};

/**
 * The value paths written to one doc instance by revisions after
 * `sinceSeq` — the field-level merge input for the wave commit step's
 * rebase of non-re-derivable writes (serving-loop.md §3d). A `set` or
 * `delete` revision reports the root path (it rewrites the whole doc);
 * a `patch` revision reports its patches' pointer paths.
 */
export const selectWritePathsSince = (
  engine: Engine,
  options: {
    branch?: BranchName;
    id: EntityId;
    scopeKey: string;
    sinceSeq: number;
  },
): Array<readonly string[]> => {
  const rows = engine.database.prepare(`
SELECT op, data FROM revision
WHERE branch = :branch AND id = :id AND scope_key = :scope_key
  AND seq > :since_seq
ORDER BY seq, op_index
`).all({
      branch: options.branch ?? DEFAULT_BRANCH,
      id: options.id,
      scope_key: options.scopeKey,
      since_seq: options.sinceSeq,
    }) as Array<{ op: string; data: string | null }>;
  const paths: Array<readonly string[]> = [];
  for (const row of rows) {
    if (row.op === "patch" && row.data !== null) {
      const patches = decodeMemoryBoundary(row.data) as PatchOp[];
      for (const patch of patches) {
        paths.push(parsePointer(patch.path));
      }
    } else {
      paths.push([]);
    }
  }
  return paths;
};

/**
 * Whether a commit after `sinceSeq` wrote this document instance that
 * `holder`'s own derived commits do not account for — serving-loop.md
 * §3d's INTRUSION on a document a serving tenure derives into. A client's
 * authored write is one; so is another holder's derived write, and a
 * system commit. The tenure's own derived commits are not, which is what
 * separates a document another writer moved under a run from one the
 * tenure itself advanced while that run was in flight.
 *
 * `holder` absent (a wave driven outside a lease) makes every write an
 * intrusion: nothing identifies a commit as this tenure's. So does a
 * derived row carrying no holder, which the class is not supposed to
 * produce. Both are the exemption failing CLOSED, and the query says so
 * in SQL rather than leaning on three-valued logic to arrive there: `=`
 * against a NULL yields UNKNOWN, and a `NOT (...)` over UNKNOWN drops the
 * row — exempting exactly the writes these two cases must not exempt.
 */
export const hasIntrusionSince = (
  engine: Engine,
  options: {
    branch?: BranchName;
    id: EntityId;
    scopeKey: string;
    sinceSeq: number;
    holder?: string;
  },
): boolean =>
  engine.database.prepare(`
SELECT 1 FROM revision r JOIN "commit" c ON c.seq = r.commit_seq
WHERE r.branch = :branch AND r.id = :id AND r.scope_key = :scope_key
  AND r.seq > :since_seq
  AND NOT (:holder IS NOT NULL AND c.class = 'derived' AND c.holder IS :holder)
LIMIT 1
`).get({
      branch: options.branch ?? DEFAULT_BRANCH,
      id: options.id,
      scope_key: options.scopeKey,
      since_seq: options.sinceSeq,
      holder: options.holder ?? null,
    }) !== undefined;

/**
 * One admitted commit as the serving loop's subscription sees it
 * (serving-loop.md §1 plane (d), §3): class + holder for the self-echo
 * skip, and the written doc INSTANCES for dirtiness marking. Assembled
 * from the commit row and its revision rows — ids and scope keys only,
 * never payloads (values travel on the ordinary session-sync path).
 */
export type CommitFeedRecord = {
  seq: number;
  branch: BranchName;
  class: CommitClass;
  holder: string | null;
  sessionId: string;
  writes: Array<{ id: EntityId; scopeKey: string }>;
};

// Per-engine memo of `commit.seq -> commit.class`. A commit's class is
// immutable once admitted, so an entry never invalidates; bounded — on
// overflow the memo clears and repopulates from live lookups.
const COMMIT_CLASS_MEMO_MAX_ENTRIES = 65_536;
const commitClassMemos = new WeakMap<Engine, Map<number, CommitClass>>();

/**
 * The class of the commit at `seq` (`commit.seq` is unique across the
 * whole store — one seq names exactly one commit, on whatever branch),
 * or undefined when no such commit exists (a seq-0 "absent doc" marker,
 * or a store older than the seq). The snapshot read that annotates
 * session frames with the covering commit's class (speculation.md §4's
 * arrival-witness predicate, RULED 2026-08-22) resolves through this:
 * every revision's `seq` IS its producing commit's seq, so the covering
 * class of a doc snapshot is the class of the commit at the snapshot's
 * seq. Deliberately no branch predicate: a snapshot can resolve to a
 * parent branch's revision, and commit seqs are global.
 */
export const commitClassOfSeq = (
  engine: Engine,
  seq: number,
): CommitClass | undefined => {
  if (seq <= 0) return undefined;
  let memo = commitClassMemos.get(engine);
  if (memo === undefined) {
    memo = new Map();
    commitClassMemos.set(engine, memo);
  }
  const cached = memo.get(seq);
  if (cached !== undefined) return cached;
  const row = engine.database.prepare(
    `SELECT class FROM "commit" WHERE seq = :seq`,
  ).get({ seq }) as { class: CommitClass } | undefined;
  if (row === undefined) return undefined;
  // "Immutable once admitted" holds for DURABLE rows only: inside a
  // transaction the same connection reads the staged, rollback-able
  // commit row, and a rolled-back seq is re-minted by the retry —
  // possibly under another class (the wave path is exactly that
  // re-mint). Same discipline as {@link cacheDocumentForRevision}'s
  // in-transaction backstop, and for the same reason it is the
  // connection state and not a caller marker: it holds for every
  // transaction-wrapped caller — `applyCommit` AND `applyWaveCommit`,
  // which opens its own transaction without staging — rather than for
  // the one that remembered to set a flag. The mid-transaction read is
  // still SERVED, just never memoized.
  if (!engine.database.inTransaction) {
    if (memo.size >= COMMIT_CLASS_MEMO_MAX_ENTRIES) memo.clear();
    memo.set(seq, row.class);
  }
  return row.class;
};

/**
 * The accepted-commit feed's catch-up read (protocol.md §3: "the
 * SpaceServer subscribes to the whole space's accepted-commit feed from a
 * seq"; serving-loop.md §6 step 2: "subscribe from the head the index scan
 * ran against; later commits arrive as ordinary input"). Returns commits
 * with seq > fromSeq in seq order. Direct-engine read on the co-hosted
 * plane — never wire, never pushed to clients.
 */
export const selectCommitsSince = (
  engine: Engine,
  options: { fromSeq: number; branch?: BranchName; limit?: number },
): CommitFeedRecord[] => {
  const branch = options.branch ?? DEFAULT_BRANCH;
  const commits = engine.database.prepare(`
SELECT seq, branch, class, holder, session_id
FROM "commit"
WHERE seq > :from_seq AND branch = :branch
ORDER BY seq
LIMIT :limit
`).all({
      from_seq: options.fromSeq,
      branch,
      limit: options.limit ?? Number.MAX_SAFE_INTEGER,
    }) as Array<{
      seq: number;
      branch: string;
      class: CommitClass;
      holder: string | null;
      session_id: string;
    }>;
  const writesFor = engine.database.prepare(`
SELECT DISTINCT id, scope_key FROM revision
WHERE commit_seq = :commit_seq
`);
  return commits.map((row) => ({
    seq: row.seq,
    branch: row.branch,
    class: row.class,
    holder: row.holder,
    sessionId: row.session_id,
    writes: (writesFor.all({ commit_seq: row.seq }) as Array<
      { id: string; scope_key: string }
    >).map((write) => ({ id: write.id, scopeKey: write.scope_key })),
  }));
};

/** One basis-row overwrite unit of a wave commit (serving-loop.md §3b):
 * `seq: null` marks an in-wave read, filled with the wave's own commit
 * seq at write time. */
export type WaveBasisInstance = {
  action: string;
  actionScopeKey: string;
  rows: ReadonlyArray<{
    entitySpace: string;
    entity: string;
    entityScopeKey: string;
    seq: number | null;
  }>;
};

/**
 * The wave commit's store transaction (server-execution v2 stage D,
 * serving-loop.md §3b–§3d): per-doc CAS re-verification against the
 * wave's basis, the commit apply (admission included — the derived-class
 * lease check, annotation keying, consequenceOf carriage), and the basis-
 * index overwrites, all in ONE engine transaction. This is what makes the
 * accumulator's sink contract implementable: between the wave's own head
 * query and this call the engine may admit concurrent commits, and the
 * re-verification here — inside the transaction — is the load-bearing
 * concurrency check (§3d forbids blind derived writes). On conflict it
 * throws {@link WaveCommitConflictError} naming the moved docs, and
 * nothing is applied.
 */
export const applyWaveCommit = (
  engine: Engine,
  options: ApplyCommitOptions & {
    waveBasis: {
      /** The wave's input snapshot seq (per-doc CAS basis). */
      basisSeq: number;

      /** Per doc-instance key (`${id} ${scopeKey}`): the head the wave's
       * rebase decision observed. Re-verification requires these docs to
       * sit at EXACTLY that head — §3d's re-CAS against the new head; a
       * further move invalidates the field-level merge. */
      rebasedHeads: ReadonlyArray<{ doc: string; head: number }>;
    };
    basisInstances?: readonly WaveBasisInstance[];

    /** The wave's outbound cross-space appends (serving-loop.md §5,
     * FP1): durable rows written INSIDE this very transaction — the
     * basis-row carriage pattern. Deleted later, on delivery-ack, by
     * the serving loop's outbox (execution-outbox.ts). */
    outboxAppends?: readonly OutboxAppendRow[];
  },
): AppliedCommit => {
  return engine.database.transaction(
    (txEngine: Engine, txOptions: typeof options) => {
      const { waveBasis, basisInstances, outboxAppends, ...restOptions } =
        txOptions;
      // Basis rows are ADDRESSING (recovery's re-mark scan matches
      // storage rows against these instance values), so their keys meet
      // the same admission bar as annotated scope keys: a non-canonical
      // key would store rows no canonical key ever matches — a silent
      // liveness hole rather than a loud one. Refused up front, before
      // any head query runs.
      for (const instance of basisInstances ?? []) {
        if (!isScopeKey(instance.actionScopeKey)) {
          throw new ProtocolError(
            `wave commit rejected: basis action instance key ` +
              `"${instance.actionScopeKey}" is not a canonical scope_key ` +
              "(key-vocabulary.md §3)",
          );
        }
        for (const row of instance.rows) {
          if (!isScopeKey(row.entityScopeKey)) {
            throw new ProtocolError(
              `wave commit rejected: basis row entity instance key ` +
                `"${row.entityScopeKey}" is not a canonical scope_key ` +
                "(key-vocabulary.md §3)",
            );
          }
        }
      }
      // An appends-only wave commits with zero operations: the durable
      // rows ride this transaction (FP1), so the emptiness guard below
      // must not refuse it.
      const applyOptions = {
        ...restOptions,
        ...(outboxAppends !== undefined && outboxAppends.length > 0
          ? { allowEmptyOperations: true }
          : {}),
      };
      const rebasedHeads = new Map(
        waveBasis.rebasedHeads.map(({ doc, head }) => [doc, head]),
      );
      const scopeKeyByOp = new Map<number, string>();
      for (const annotation of applyOptions.annotations ?? []) {
        if (annotation.scopeKey !== undefined) {
          scopeKeyByOp.set(annotation.op, annotation.scopeKey);
        }
      }
      const conflicted = new Set<string>();
      const checked = new Set<string>();
      for (
        const [opIndex, operation] of applyOptions.commit.operations.entries()
      ) {
        if (operation.op === "sqlite") continue;
        // A space-declared op never takes an annotated key: the apply
        // below refuses such an annotation as a ProtocolError, and keying
        // this pre-check by the DECLARED scope keeps that refusal — not a
        // phantom, resolvable-looking conflict — the error the wave sees.
        const annotated = normalizeScope(operation.scope) === "space"
          ? undefined
          : scopeKeyByOp.get(opIndex);
        const scopeKey = annotated ??
          resolveScopeKey(operation.scope, {
            principal: applyOptions.principal,
            sessionId: applyOptions.sessionId,
          });
        const key = `${operation.id} ${scopeKey}`;
        if (checked.has(key)) continue;
        checked.add(key);
        const head = selectDocHead(txEngine, {
          branch: applyOptions.commit.branch,
          id: operation.id,
          scopeKey,
        });
        const rebasedAt = rebasedHeads.get(key);
        if (rebasedAt !== undefined) {
          // A rebased write: sound only against the exact head its
          // field-level merge was decided at.
          if (head !== rebasedAt) conflicted.add(key);
        } else if (head > waveBasis.basisSeq) {
          conflicted.add(key);
        }
      }
      if (conflicted.size > 0) {
        throw new WaveCommitConflictError([...conflicted]);
      }
      // Preconditions pre-checked ONE BY ONE so a failure names its
      // index: the shared validator throws on the first failure without
      // saying which, and the wave commit step needs per-owner
      // resolution (WavePreconditionError above). The synthetic
      // single-precondition commit reuses the validator unchanged; the
      // apply below re-runs the full set inside this same transaction,
      // which — having passed here — cannot fail there.
      const failedPreconditions: number[] = [];
      let firstDetail = "";
      const sessionKey = resolveCommitSessionKey(
        applyOptions.sessionId,
        applyOptions.principal,
      );
      const branch = applyOptions.commit.branch ?? DEFAULT_BRANCH;
      for (
        const [index, precondition] of (
          applyOptions.commit.preconditions ?? []
        ).entries()
      ) {
        try {
          validateCommitPreconditions(txEngine, sessionKey, branch, {
            ...applyOptions.commit,
            preconditions: [precondition],
          }, {
            principal: applyOptions.principal,
            sessionId: applyOptions.sessionId,
          });
        } catch (error) {
          if (error instanceof PreconditionFailedError) {
            failedPreconditions.push(index);
            if (firstDetail === "") {
              firstDetail = error.message;
            }
          } else {
            throw error;
          }
        }
      }
      if (failedPreconditions.length > 0) {
        throw new WavePreconditionError(failedPreconditions, firstDetail);
      }
      const applied = applyCommitTransaction(txEngine, applyOptions);
      for (const instance of basisInstances ?? []) {
        replaceSchedulerBasisRows(txEngine, {
          branch,
          action: instance.action,
          actionScopeKey: instance.actionScopeKey,
          rows: instance.rows.map((row) => ({
            entitySpace: row.entitySpace,
            entity: row.entity,
            entityScopeKey: row.entityScopeKey,
            seq: row.seq ?? applied.seq,
          })),
        });
      }
      // FP1 (serving-loop.md §5): the wave's outbound append rows land
      // inside this same transaction — atomically with the wave commit,
      // so a crash either has both (rows re-sent, deduped at the
      // target's eventId horizon) or neither (the wave never happened).
      // Gated on a NEWLY INSERTED commit: an exact replay returns the
      // stored result without applying anything, and its original
      // application already carried these rows — re-inserting would
      // resurrect rows the drain may have delivered and retired,
      // producing duplicate durable delivery work (the target's
      // eventId horizon dedupes the duplicates, but each one costs a
      // delegated-append round trip and a dedupe pass).
      if (
        applied.replayed !== true &&
        outboxAppends !== undefined && outboxAppends.length > 0
      ) {
        insertExecutionOutboxRows(txEngine, {
          branch,
          createdSeq: applied.seq,
          rows: outboxAppends,
        });
      }
      return applied;
    },
  ).immediate(engine, options);
};

// Per-version record of stored schema documents whose content verified
// during commit-time closure validation, held as the interned schema, so a
// writer re-referencing the same closure pays map lookups, not re-hashes.
// Bounded; wholesale eviction on overflow.
const SCHEMA_DOC_CACHE_MAX_ENTRIES = 4096;
const schemaDocCaches = new WeakMap<
  Engine,
  Map<string, { seq: number; schema: JSONSchema }>
>();
const schemaDocCache = (
  engine: Engine,
): Map<string, { seq: number; schema: JSONSchema }> => {
  let cache = schemaDocCaches.get(engine);
  if (cache === undefined) {
    cache = new Map();
    schemaDocCaches.set(engine, cache);
  }
  return cache;
};

type OperationFieldRow = {
  epoch: number;
  codec: string;
  version: number;
  baseline_hash: string;
  materialized: string;
  active: number;
};

type OperationSubmissionRow = {
  epoch: number;
  submission_id: string;
  codec: string;
  base_version: number;
  submitted_payload: string;
  integrated_from: number;
  integrated_to: number;
  integrated_payload: string;
};

type IntegratedOperationRow = {
  version: number;
  op_id: string;
  submission_id: string;
  payload: string;
};

const encodedOperationPath = (path: readonly string[]): string =>
  encodePointer(path);

const operationFieldParams = (
  branch: BranchName,
  id: EntityId,
  scopeKey: string,
  path: readonly string[],
) => ({ branch, id, scope_key: scopeKey, path: encodedOperationPath(path) });

const valueAtOperationPath = (
  document: EntityDocument | null,
  path: readonly string[],
): FabricValue => {
  let value: FabricValue = document?.value ?? null;
  for (const part of path) {
    if (Array.isArray(value)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= value.length) {
        throw new ProtocolError(
          `operation field path is missing: ${path.join(".")}`,
        );
      }
      value = value[index];
    } else if (
      isObjectOrArray(value) &&
      Object.hasOwn(value, part)
    ) {
      value = (value as Record<string, FabricValue>)[part];
    } else {
      throw new ProtocolError(
        `operation field path is missing: ${path.join(".")}`,
      );
    }
  }
  return value;
};

const selectOperationField = (
  engine: Engine,
  params: ReturnType<typeof operationFieldParams>,
): OperationFieldRow | undefined =>
  engine.database.prepare(`
    SELECT epoch, codec, version, baseline_hash, materialized, active
    FROM op_field_epoch
    WHERE branch = :branch AND id = :id AND scope_key = :scope_key
      AND path = :path
  `).get(params) as OperationFieldRow | undefined;

const selectIntegratedOperations = (
  engine: Engine,
  params: ReturnType<typeof operationFieldParams> & {
    epoch: number;
    after_version: number;
  },
): IntegratedOperationRow[] =>
  engine.database.prepare(`
    SELECT version, op_id, submission_id, payload
    FROM op_integrated
    WHERE branch = :branch AND id = :id AND scope_key = :scope_key
      AND path = :path AND epoch = :epoch AND version > :after_version
    ORDER BY version
  `).all(params) as IntegratedOperationRow[];

const retainedOperationVersion = (
  engine: Engine,
  params: ReturnType<typeof operationFieldParams>,
  field: OperationFieldRow,
): number => {
  const row = engine.database.prepare(`
    SELECT MIN(version) AS version
    FROM op_integrated
    WHERE branch = :branch AND id = :id AND scope_key = :scope_key
      AND path = :path AND epoch = :epoch
  `).get({ ...params, epoch: field.epoch }) as { version: number | null };
  return row.version === null ? field.version : row.version - 1;
};

const assertDefaultOperationBranch = (branch: BranchName): void => {
  if (branch !== DEFAULT_BRANCH) {
    throw new ProtocolError(
      "collaborative operation fields only support the default branch",
    );
  }
};

const decodedIntegratedOperations = (
  epoch: number,
  rows: readonly IntegratedOperationRow[],
): IntegratedOperation[] =>
  rows.map((row) => ({
    opId: row.op_id,
    cursor: { epoch, version: row.version },
    submissionId: row.submission_id,
    payload: decodeMemoryBoundary(row.payload),
  }));

const MAX_OPERATION_PAYLOAD_BYTES = 1_000_000;
const MAX_OPERATION_BATCH_UPDATES = 256;
const operationValueByteLength = (value: FabricValue): number =>
  new TextEncoder().encode(encodeMemoryBoundary(value)).byteLength;

function validateOperationPath(path: unknown): asserts path is ValuePath {
  if (
    !Array.isArray(path) || path.length > 256 ||
    path.some((part) => typeof part !== "string" || part.length > 1024)
  ) {
    throw new ProtocolError("operation field path is malformed or too large");
  }
}

const validateCursor = (cursor: unknown): cursor is OpCursor =>
  isObjectOrArray(cursor) &&
  Number.isSafeInteger((cursor as { epoch?: unknown }).epoch) &&
  (cursor as { epoch: number }).epoch > 0 &&
  Number.isSafeInteger((cursor as { version?: unknown }).version) &&
  (cursor as { version: number }).version >= 0;

const validateApplyOperation = (operation: ApplyOpOperation): void => {
  validateOperationPath(operation.path);
  if (
    typeof operation.id !== "string" || operation.id.length === 0 ||
    typeof operation.codec !== "string" ||
    !/@[1-9][0-9]*$/.test(operation.codec) ||
    typeof operation.submissionId !== "string" ||
    operation.submissionId.length === 0 || operation.submissionId.length > 256
  ) {
    throw new ProtocolError("apply-op identity fields are malformed");
  }
  if (operation.base !== null && !validateCursor(operation.base)) {
    throw new OpCursorMismatchError("apply-op cursor is malformed");
  }
  if (
    operation.base === null
      ? typeof operation.baselineHash !== "string" ||
        operation.baselineHash.length === 0
      : operation.baselineHash !== undefined
  ) {
    throw new OpFieldBaselineMismatchError(
      "baselineHash is required exactly when apply-op base is null",
    );
  }
  if (
    operationValueByteLength(operation.payload) > MAX_OPERATION_PAYLOAD_BYTES
  ) {
    throw new OpCodecError("operation payload exceeds the byte limit");
  }
  const updates = isObjectNotArray(operation.payload)
    ? (operation.payload as { updates?: unknown }).updates
    : undefined;
  if (Array.isArray(updates) && updates.length > MAX_OPERATION_BATCH_UPDATES) {
    throw new OpCodecError("operation payload exceeds the update-count limit");
  }
};

const storedOperationResolution = (
  operationIndex: number,
  address: ApplyOpResolution["address"],
  row: OperationSubmissionRow,
  duplicate: boolean,
): ApplyOpResolution => {
  const payloads = decodeMemoryBoundary<FabricValue[]>(row.integrated_payload);
  return {
    operationIndex,
    address,
    codec: row.codec,
    submissionId: row.submission_id,
    from: { epoch: row.epoch, version: row.integrated_from },
    to: { epoch: row.epoch, version: row.integrated_to },
    operations: payloads.map((payload, index) => ({
      opId: integratedOperationId(
        address,
        row.epoch,
        row.integrated_from + index + 1,
      ),
      cursor: { epoch: row.epoch, version: row.integrated_from + index + 1 },
      submissionId: row.submission_id,
      payload,
    })),
    duplicate,
  };
};

const applyOperation = (
  engine: Engine,
  options: {
    branch: BranchName;
    seq: number;
    opIndex: number;
    operation: ApplyOpOperation;
    principal?: string;
    sessionId: SessionId;
    scopeKeyOverride?: string;
  },
): { resolution: ApplyOpResolution; revision?: AppliedRevision } => {
  const { branch, seq, opIndex, operation, principal, sessionId } = options;
  assertDefaultOperationBranch(branch);
  validateApplyOperation(operation);
  if (isStreamEntriesDocId(operation.id)) {
    throw new ProtocolError(
      "apply-op cannot mutate a stream sidecar document",
    );
  }
  const scope = normalizeScope(operation.scope);
  const scopeKey = options.scopeKeyOverride ??
    resolveScopeKey(operation.scope, { principal, sessionId });
  const params = operationFieldParams(
    branch,
    operation.id,
    scopeKey,
    operation.path,
  );
  const address: ApplyOpResolution["address"] = {
    branch,
    id: operation.id,
    ...(scope === DEFAULT_SCOPE ? {} : { scope }),
    scopeKey,
    path: operation.path,
  };
  const priorField = selectOperationField(engine, params);
  const submissionEpoch = priorField?.active === 1
    ? priorField.epoch
    : (priorField?.epoch ?? 0) + 1;

  const duplicate = engine.database.prepare(`
    SELECT epoch, submission_id, codec, base_version, submitted_payload,
           integrated_from, integrated_to, integrated_payload
    FROM op_submission
    WHERE branch = :branch AND id = :id AND scope_key = :scope_key
      AND path = :path AND epoch = :epoch
      AND submission_id = :submission_id
  `).get({
    ...params,
    epoch: submissionEpoch,
    submission_id: operation.submissionId,
  }) as
    | OperationSubmissionRow
    | undefined;
  if (duplicate) {
    if (
      duplicate.codec !== operation.codec ||
      (operation.base !== null && operation.base.epoch !== duplicate.epoch) ||
      duplicate.base_version !== (operation.base?.version ?? 0) ||
      (operation.base === null &&
        operation.baselineHash !== priorField?.baseline_hash) ||
      duplicate.submitted_payload !== encodeMemoryBoundary(operation.payload)
    ) {
      throw new OpSubmissionMismatchError(
        `operation submission replay mismatch: ${operation.submissionId}`,
      );
    }
    return {
      resolution: storedOperationResolution(opIndex, address, duplicate, true),
    };
  }

  const currentDocument = readStateForScopeKey(engine, {
    branch,
    id: operation.id,
    scope,
    scopeKey,
  })?.document ?? null;
  const currentMaterialized = valueAtOperationPath(
    currentDocument,
    operation.path,
  );
  const activeField = priorField?.active === 1 ? priorField : undefined;

  let epoch: number;
  let currentVersion: number;
  let baselineHash: string;
  let intervening: FabricValue[];
  if (!activeField) {
    if (operation.base !== null) {
      throw new OpCursorMismatchError(
        "inactive operation fields require a null base",
      );
    }
    const currentHash = operationBaselineHash(currentMaterialized);
    if (operation.baselineHash !== currentHash) {
      throw new OpFieldBaselineMismatchError(
        "operation field baseline hash mismatch",
      );
    }
    epoch = (priorField?.epoch ?? 0) + 1;
    currentVersion = 0;
    baselineHash = currentHash;
    intervening = [];
    engine.database.prepare(`
      INSERT INTO op_checkpoint (
        branch, id, scope_key, path, epoch, version, materialized, commit_seq
      ) VALUES (
        :branch, :id, :scope_key, :path, :epoch, 0, :materialized, :commit_seq
      )
    `).run({
      ...params,
      epoch,
      materialized: encodeMemoryBoundary(currentMaterialized),
      commit_seq: seq,
    });
  } else {
    if (operation.codec !== activeField.codec) {
      throw new OpCodecError(
        "operation field codec cannot change within an epoch",
      );
    }
    let baseVersion: number;
    if (operation.base === null) {
      if (operation.baselineHash !== activeField.baseline_hash) {
        throw new OpFieldBaselineMismatchError(
          "operation field baseline hash mismatch",
        );
      }
      baseVersion = 0;
    } else {
      if (operation.base.epoch !== activeField.epoch) {
        throw new OpCursorMismatchError("operation field epoch mismatch");
      }
      if (operation.base.version > activeField.version) {
        throw new OpCursorMismatchError(
          "operation field base version is in the future",
        );
      }
      baseVersion = operation.base.version;
    }
    epoch = activeField.epoch;
    currentVersion = activeField.version;
    baselineHash = activeField.baseline_hash;
    const retainedVersion = retainedOperationVersion(
      engine,
      params,
      activeField,
    );
    if (baseVersion < retainedVersion) {
      throw new OpHistoryUnavailableError(
        `operation field history before version ${retainedVersion} is unavailable`,
      );
    }
    intervening = selectIntegratedOperations(engine, {
      ...params,
      epoch,
      after_version: baseVersion,
    }).map((row) => decodeMemoryBoundary(row.payload));
    if (
      operationBaselineHash(currentMaterialized) !==
        operationBaselineHash(decodeMemoryBoundary(activeField.materialized))
    ) {
      throw new ProtocolError(
        "operation field materialization diverged from the entity value",
      );
    }
  }

  let result;
  try {
    let codec;
    try {
      codec = engine.operationCodecs.require(operation.codec);
    } catch {
      throw new UnsupportedOpCodecError(
        `unknown operation codec: ${operation.codec}`,
      );
    }
    result = codec.integrate({
      materialized: currentMaterialized,
      submitted: operation.payload,
      intervening,
    });
  } catch (cause) {
    if (cause instanceof ProtocolError) throw cause;
    throw new OpCodecError(
      `operation codec ${operation.codec} rejected the payload: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  if (result.operations.length > MAX_OPERATION_BATCH_UPDATES) {
    throw new OpCodecError("operation codec produced too many operations");
  }
  try {
    if (
      operationValueByteLength(result.materialized) >
        MAX_OPERATION_PAYLOAD_BYTES
    ) {
      throw new OpCodecError(
        "operation materialized value exceeds the byte limit",
      );
    }
    for (const payload of result.operations) {
      if (operationValueByteLength(payload) > MAX_OPERATION_PAYLOAD_BYTES) {
        throw new OpCodecError(
          "integrated operation exceeds the byte limit",
        );
      }
    }
  } catch (cause) {
    if (cause instanceof ProtocolError) throw cause;
    throw new OpCodecError(
      `operation codec produced an invalid Fabric value: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  if (
    result.operations.length === 0 &&
    !valueEqual(result.materialized, currentMaterialized)
  ) {
    throw new OpCodecError(
      "operation codec changed the materialized value without producing an operation",
    );
  }

  const nextVersion = currentVersion + result.operations.length;
  engine.database.prepare(`
    INSERT INTO op_field_epoch (
      branch, id, scope_key, path, epoch, codec, version,
      baseline_hash, materialized, active, commit_seq
    ) VALUES (
      :branch, :id, :scope_key, :path, :epoch, :codec, :version,
      :baseline_hash, :materialized, 1, :commit_seq
    )
    ON CONFLICT (branch, id, scope_key, path) DO UPDATE SET
      epoch = excluded.epoch,
      codec = excluded.codec,
      version = excluded.version,
      baseline_hash = excluded.baseline_hash,
      materialized = excluded.materialized,
      active = 1,
      commit_seq = excluded.commit_seq
  `).run({
    ...params,
    epoch,
    codec: operation.codec,
    version: nextVersion,
    baseline_hash: baselineHash,
    materialized: encodeMemoryBoundary(result.materialized),
    commit_seq: seq,
  });

  for (const [index, payload] of result.operations.entries()) {
    engine.database.prepare(`
      INSERT INTO op_integrated (
        branch, id, scope_key, path, epoch, version, op_id,
        submission_id, payload, commit_seq
      ) VALUES (
        :branch, :id, :scope_key, :path, :epoch, :version, :op_id,
        :submission_id, :payload, :commit_seq
      )
    `).run({
      ...params,
      epoch,
      version: currentVersion + index + 1,
      op_id: integratedOperationId(
        address,
        epoch,
        currentVersion + index + 1,
      ),
      submission_id: operation.submissionId,
      payload: encodeMemoryBoundary(payload),
      commit_seq: seq,
    });
  }
  if (
    result.operations.length !== 0 &&
    Math.floor(nextVersion / engine.operationCheckpointInterval) >
      Math.floor(currentVersion / engine.operationCheckpointInterval)
  ) {
    engine.database.prepare(`
      INSERT INTO op_checkpoint (
        branch, id, scope_key, path, epoch, version, materialized, commit_seq
      ) VALUES (
        :branch, :id, :scope_key, :path, :epoch, :version,
        :materialized, :commit_seq
      )
    `).run({
      ...params,
      epoch,
      version: nextVersion,
      materialized: encodeMemoryBoundary(result.materialized),
      commit_seq: seq,
    });
    const priorCheckpoint = engine.database.prepare(`
      SELECT version
      FROM op_checkpoint
      WHERE branch = :branch AND id = :id AND scope_key = :scope_key
        AND path = :path AND epoch = :epoch AND version < :version
      ORDER BY version DESC
      LIMIT 1
    `).get({ ...params, epoch, version: nextVersion }) as
      | { version: number }
      | undefined;
    if (priorCheckpoint !== undefined && priorCheckpoint.version > 0) {
      engine.database.prepare(`
        DELETE FROM op_integrated
        WHERE branch = :branch AND id = :id AND scope_key = :scope_key
          AND path = :path AND epoch = :epoch AND version <= :version
      `).run({
        ...params,
        epoch,
        version: priorCheckpoint.version,
      });
    }
  }
  engine.database.prepare(`
    INSERT INTO op_submission (
      branch, id, scope_key, path, epoch, submission_id, codec,
      base_version, submitted_payload, integrated_from, integrated_to,
      integrated_payload, commit_seq, op_index
    ) VALUES (
      :branch, :id, :scope_key, :path, :epoch, :submission_id, :codec,
      :base_version, :submitted_payload, :integrated_from, :integrated_to,
      :integrated_payload, :commit_seq, :op_index
    )
  `).run({
    ...params,
    epoch,
    submission_id: operation.submissionId,
    codec: operation.codec,
    base_version: operation.base?.version ?? 0,
    submitted_payload: encodeMemoryBoundary(operation.payload),
    integrated_from: currentVersion,
    integrated_to: nextVersion,
    integrated_payload: encodeMemoryBoundary(result.operations),
    commit_seq: seq,
    op_index: opIndex,
  });

  const submissionRow: OperationSubmissionRow = {
    epoch,
    submission_id: operation.submissionId,
    codec: operation.codec,
    base_version: operation.base?.version ?? 0,
    submitted_payload: encodeMemoryBoundary(operation.payload),
    integrated_from: currentVersion,
    integrated_to: nextVersion,
    integrated_payload: encodeMemoryBoundary(result.operations),
  };
  const resolution = storedOperationResolution(
    opIndex,
    address,
    submissionRow,
    false,
  );
  if (result.operations.length === 0) return { resolution };

  const revision = writeOperation(engine, {
    branch,
    seq,
    opIndex,
    principal,
    sessionId,
    scopeKeyOverride: options.scopeKeyOverride,
    operation: {
      op: "patch",
      id: operation.id,
      ...(operation.scope === undefined ? {} : { scope: operation.scope }),
      patches: [{
        op: "replace",
        path: encodePointer(["value", ...operation.path]),
        value: result.materialized,
      }],
    },
  });
  return { resolution, revision };
};

const releaseOperationField = (
  engine: Engine,
  options: {
    branch: BranchName;
    operation: ReleaseOpFieldOperation;
    principal?: string;
    sessionId: SessionId;
    scopeKeyOverride?: string;
  },
): void => {
  const { branch, operation, principal, sessionId } = options;
  assertDefaultOperationBranch(branch);
  validateOperationPath(operation.path);
  if (!validateCursor(operation.cursor)) {
    throw new OpCursorMismatchError(
      "operation field release cursor is malformed",
    );
  }
  if (typeof operation.codec !== "string") {
    throw new OpCodecError("operation field release codec is malformed");
  }
  const scopeKey = options.scopeKeyOverride ??
    resolveScopeKey(operation.scope, { principal, sessionId });
  const params = operationFieldParams(
    branch,
    operation.id,
    scopeKey,
    operation.path,
  );
  const field = selectOperationField(engine, params);
  if (
    !field || field.active !== 1 || field.epoch !== operation.cursor.epoch ||
    field.version !== operation.cursor.version
  ) {
    throw new OpCursorMismatchError("operation field release cursor mismatch");
  }
  if (field.codec !== operation.codec) {
    throw new OpCodecError("operation field release codec mismatch");
  }
  engine.database.prepare(`
    UPDATE op_field_epoch SET active = 0
    WHERE branch = :branch AND id = :id AND scope_key = :scope_key
      AND path = :path
  `).run(params);
};

const releaseEntityOperationFields = (
  engine: Engine,
  branch: BranchName,
  id: EntityId,
  scopeKey: string,
): void => {
  engine.database.prepare(`
    UPDATE op_field_epoch SET active = 0
    WHERE branch = :branch AND id = :id AND scope_key = :scope_key
  `).run({ branch, id, scope_key: scopeKey });
};

const assertOperationFieldsPreserved = (
  engine: Engine,
  options: {
    branch: BranchName;
    operation: SetOperation | PatchOperation;
    principal?: string;
    sessionId: SessionId;
    scopeKeyOverride?: string;
  },
): void => {
  const { branch, operation, principal, sessionId } = options;
  const scopeKey = options.scopeKeyOverride ??
    resolveScopeKey(operation.scope, { principal, sessionId });
  const activeFields = engine.database.prepare(`
    SELECT path, materialized
    FROM op_field_epoch
    WHERE branch = :branch AND id = :id AND scope_key = :scope_key
      AND active = 1
  `).all({ branch, id: operation.id, scope_key: scopeKey }) as Array<{
    path: string;
    materialized: string;
  }>;
  if (activeFields.length === 0) return;

  const currentDocument = readStateForScopeKey(engine, {
    branch,
    id: operation.id,
    scope: normalizeScope(operation.scope),
    scopeKey,
  })?.document;
  const nextDocument = operation.op === "set"
    ? operation.value
    : applyPatchToDocument(currentDocument ?? undefined, operation.patches);
  for (const field of activeFields) {
    const path = parsePointer(field.path);
    let nextValue: FabricValue;
    try {
      nextValue = valueAtOperationPath(nextDocument, path);
    } catch {
      throw new OpFieldWriteConflictError(
        `ordinary write removes active operation field: ${path.join(".")}`,
      );
    }
    const materialized = decodeMemoryBoundary(field.materialized);
    if (
      operationBaselineHash(nextValue) !== operationBaselineHash(materialized)
    ) {
      throw new OpFieldWriteConflictError(
        `ordinary write changes active operation field: ${path.join(".")}`,
      );
    }
  }
};

const applyCommitTransaction = (
  engine: Engine,
  {
    sessionId,
    space,
    principal,
    commit,
    sqliteAttachments,
    commitClass = "authored",
    holder,
    annotations,
    consequenceOf,
    derivedThrough,
    delegated,
    systemEventActor,
    allowEmptyOperations,
  }: ApplyCommitOptions,
): AppliedCommit => {
  // The derived-class posture gate (protocol.md §1): off the flag NOTHING
  // may claim the class — retries included — because `derived` names the
  // single-deriver posture and nothing outside EXPERIMENTAL_SERVER_EXECUTION
  // may claim it. Only this gate precedes replay detection; the LIVE-lease
  // equality check sits after it below, on the fresh-commit path.
  if (commitClass === "derived" && !getServerExecutionConfig()) {
    throw new ProtocolError(
      "derived-class commits are unclaimable while " +
        "EXPERIMENTAL_SERVER_EXECUTION is off (protocol.md §1)",
    );
  }
  const sessionKey = resolveCommitSessionKey(sessionId, principal);
  // Replay detection FIRST — ahead of every current-authority admission
  // check, the live-lease equality check included (owner review on #5349,
  // 2026-08-12): a commit this session already applied returns its stored
  // result without re-validating preconditions — re-checking entity-absent
  // against the state the original application created would wrongly reject
  // the replay — and without consulting the live `execution_lease`: the
  // lease authorizes NEW derived commits, and a network retry of an
  // already-ACCEPTED one must keep its stored answer after the producing
  // lease was released, expired, or succeeded by a new holder. The stored
  // identity spans the payload bytes (sameStoredOriginal) AND the admission
  // envelope (class; for derived, the producing holder): a same-key
  // resubmission differing in either is a DIFFERENT submission and is
  // refused, never answered.
  const existing = engine.statements.selectExistingCommit.get({
    session_id: sessionKey,
    local_seq: commit.localSeq,
  }) as CommitRow | undefined;
  if (existing) {
    if (!sameStoredOriginal(existing.original, commit)) {
      throw new ProtocolError(
        `commit replay mismatch for session ${sessionId} localSeq ${commit.localSeq}`,
      );
    }
    // Envelope identity, normalized exactly as the insert below persists
    // it: a holder sticks to derived commits only, so a stray holder that
    // was inert on the original stays inert on the retry.
    const incomingHolder = commitClass === "derived" ? holder ?? null : null;
    if (existing.class !== commitClass || existing.holder !== incomingHolder) {
      throw new ProtocolError(
        `commit replay mismatch for session ${sessionId} localSeq ` +
          `${commit.localSeq}: stored class/holder differ from the resubmission`,
      );
    }
    const replayedRevisions = selectCommitRevisions(engine, existing.seq);
    // Re-derive the elision report: an elided operation persisted no
    // revision, so a replayed verdict must name it again or the accept
    // path would classify the unchanged document as dirty.
    const revisionOpIndexes = new Set(
      replayedRevisions.map((revision) => revision.opIndex),
    );
    const replayedElided = commit.operations.flatMap((operation, opIndex) =>
      operation.op !== "sqlite" && !revisionOpIndexes.has(opIndex)
        ? [opIndex]
        : []
    );
    const storedResolution = decodeMemoryBoundary(existing.resolution) as
      & FabricValue
      & { operationResolutions?: ApplyOpResolution[] };
    return {
      seq: existing.seq,
      branch: existing.branch,
      revisions: replayedRevisions,
      ...(storedResolution.operationResolutions
        ? { operationResolutions: storedResolution.operationResolutions }
        : {}),
      ...(replayedElided.length > 0 ? { elidedOpIndexes: replayedElided } : {}),
      replayed: true,
    };
  }

  // The derived-class admission rule (serving-loop.md §2, protocol.md §2's
  // `derived` row): the producer holds the space's live `execution_lease` —
  // ONE equality check against the row's holder, not admission machinery.
  // Fresh commits only: an exact replay already answered from the store
  // above. Liveness is judged by THIS process's clock — the memory
  // server's own, never the holder's: the select excludes expired rows, so
  // an expired lease matches nobody and a fresh derived commit under one
  // is rejected even before any successor acquires.
  if (commitClass === "derived") {
    const lease = space === undefined
      ? undefined
      : engine.statements.selectLiveExecutionLease.get({
        space,
        now: Date.now(),
      }) as { holder: string } | undefined;
    if (
      holder === undefined || lease === undefined || lease.holder !== holder
    ) {
      throw new ProtocolError(
        "derived-class commit rejected: producer does not hold the live " +
          "execution_lease for the space (serving-loop.md §2)",
      );
    }
    // Derived-envelope defense-in-depth (protocol.md §2, RULED 2026-08-05):
    // the commit's producing SESSION must be the lease holder's OWN service
    // session. The engine-side operand mapping (stage F design): the
    // holder's service session is the engine session whose resolved commit
    // session key EQUALS the holder identity — the wave sink commits with
    // `sessionId === holder` and no principal, so the envelope principal IS
    // the lease holder, read literally (protocol.md §1). A derived commit
    // arriving under a user session — or any session other than the
    // declared holder's — is REFUSED even though it named the right holder,
    // closing the "single honest internal caller" gap before stage F
    // multiplies the callers of the co-hosted engine plane. This mirrors
    // the executable model's `admitDerived`, which compares the envelope
    // principal to `holderId`.
    if (resolveCommitSessionKey(sessionId, principal) !== holder) {
      throw new ProtocolError(
        "derived-class commit rejected: producing session is not the " +
          "lease holder's own service session (protocol.md §2, RULED " +
          "2026-08-05)",
      );
    }
    if (delegated !== undefined) {
      throw new ProtocolError(
        "delegated-identity carriage is server-produced AUTHORED " +
          "admission only (protocol.md §2's delegated row); a derived " +
          "commit's identity rides its per-write annotations",
      );
    }
  } else if (
    annotations !== undefined || consequenceOf !== undefined ||
    derivedThrough !== undefined
  ) {
    // protocol.md §7's closed metadata list: the annotation pair,
    // consequenceOf, and derivedThrough are DERIVED-only carriage. No
    // session-facing path can supply them (`ClientCommit` cannot express
    // any of the three), so reaching here on another class is a
    // server-side plumbing bug, refused loudly.
    throw new ProtocolError(
      "write annotations, consequenceOf, and derivedThrough are " +
        "derived-commit carriage only (protocol.md §1, §7)",
    );
  }
  if (systemEventActor !== undefined) {
    if (commitClass !== "system") {
      throw new ProtocolError(
        "system event actor carriage is system-commit admission only " +
          "(events.md §5)",
      );
    }
    if (
      systemEventActor.principal === "" || systemEventActor.sessionId === "" ||
      principal !== systemEventActor.principal
    ) {
      throw new ProtocolError(
        "system event actor carriage requires the authenticated principal " +
          "and current session (events.md §5)",
      );
    }
    if ((commit.eventAppends?.length ?? 0) === 0) {
      throw new ProtocolError(
        "system event actor carriage requires a declared Retry append " +
          "(events.md §5)",
      );
    }
  }
  // The delegated row (protocol.md §2, §2b): server-produced AUTHORED
  // commits carry the originating chain actor + capabilityRef, and
  // admission validates the grant — delegation, never session-identity
  // impersonation. The Phase-1 validation floor: the carriage must be
  // COMPLETE (an actor with no grant, or a grant with no actor, is
  // refused loudly), the class must be authored, and scoped writes key
  // from the CARRIED identity below. Resolving the grant against a
  // per-doc capability store is future hardening the row names
  // (protocol.md §2's anticipated grant-scoped checks); today's ACL
  // model has no per-doc grants to resolve against, so presence +
  // completeness is the whole check — deliberately stated, not implied.
  if (delegated !== undefined) {
    if (commitClass !== "authored") {
      throw new ProtocolError(
        "delegated-identity carriage is authored-class admission only " +
          "(protocol.md §2's delegated row)",
      );
    }
    if (
      delegated.capabilityRef === undefined || delegated.capabilityRef === ""
    ) {
      // Grant presence is MANDATORY on every delegated batch — the
      // sessionless-space-scope carve-out below lifts only the acting
      // PRINCIPAL, never the grant (protocol.md §2, SHAPE RULED
      // 2026-08-05; verification-coverage OW15).
      throw new ProtocolError(
        "delegated admission requires the capability grant " +
          "(protocol.md §2's server-produced authored row) — partial " +
          "carriage is refused, never defaulted",
      );
    }
    if (
      delegated.actingPrincipal === undefined ||
      delegated.actingPrincipal === ""
    ) {
      // The Phase-3 floor carve-out (SHAPE RULED 2026-08-05, protocol.md
      // §2; implemented here with Phase 3's events — OW15): an ABSENT
      // acting principal is admissible IFF the batch is DECLARED
      // sessionless-space-scope — a chain with NO actor anywhere
      // (events.md §2: a space-scope derivation's emission, a timer),
      // whose entries stamp `firedAt = { session: "server" }` with no
      // user key. Userless WITHOUT the declaration stays refused — the
      // floor negative both ways.
      if (delegated.sessionlessSpaceScope !== true) {
        throw new ProtocolError(
          "delegated admission requires the acting principal " +
            "(protocol.md §2's server-produced authored row) — a " +
            "userless batch admits only under the declared " +
            "sessionless-space-scope carve-out (SHAPE RULED 2026-08-05)",
        );
      }
      if (
        delegated.actingSession !== undefined &&
        delegated.actingSession !== ""
      ) {
        throw new ProtocolError(
          "delegated admission rejected: a sessionless-space-scope " +
            "declaration alongside an acting session is a contradiction " +
            "— the declaration names a chain with NO actor (events.md " +
            "§2, protocol.md §2)",
        );
      }
    } else if (delegated.sessionlessSpaceScope === true) {
      throw new ProtocolError(
        "delegated admission rejected: a sessionless-space-scope " +
          "declaration alongside an acting principal is a contradiction " +
          "— the declaration names a chain with NO actor (events.md §2, " +
          "protocol.md §2)",
      );
    }
    // NOTE: the sessionless/userless scoped-write refusals (session-scope
    // chimera + the OW15 user-scope twin) moved BELOW the exact-replay
    // return per the stage-B replay-ordering rule — see the combined
    // block after the replay check.
  }

  // Derived commits key scoped writes by their EXPLICIT annotation
  // scopeKey (protocol.md §1's ADDRESSING): the wave's envelope is the
  // SpaceServer's service identity — no user principal, no session — so
  // deriving keys from it would silently resolve `user:<serviceDID>`, the
  // empty-instance trap protocol.md §2 exists to prevent. Fail closed: a
  // scoped write with no annotated key is rejected, never defaulted.
  const scopeKeyByOpIndex = new Map<number, string>();
  if (commitClass === "derived") {
    for (const annotation of annotations ?? []) {
      if (annotation.scopeKey !== undefined) {
        scopeKeyByOpIndex.set(annotation.op, annotation.scopeKey);
      }
    }
    for (const [opIndex, operation] of commit.operations.entries()) {
      if (operation.op === "sqlite") continue;
      const declared = normalizeScope(operation.scope);
      const annotated = scopeKeyByOpIndex.get(opIndex);
      if (declared === "space") {
        // protocol.md §1's ADDRESSING is one per SCOPED write, and §7's
        // closed list sanctions nothing else: an annotation aimed at a
        // space-scoped op would otherwise be silently APPLIED as the
        // row's key (writeOperation's scopeKeyOverride below), re-keying
        // a space-visible doc into a scoped instance nothing declared.
        // Fail closed, like the missing-annotation branch.
        if (annotated !== undefined) {
          throw new ProtocolError(
            `derived-class commit rejected: scope_key annotation ` +
              `"${annotated}" targets a space-scoped write ` +
              `(op ${opIndex}); addressing is one per SCOPED write ` +
              "(protocol.md §1, §7)",
          );
        }
        continue;
      }
      if (annotated === undefined) {
        throw new ProtocolError(
          `derived-class commit rejected: scoped write (op ${opIndex}, ` +
            `scope "${declared}") carries no explicit scope_key ` +
            "annotation (protocol.md §1)",
        );
      }
      // The annotated key becomes the row's key VERBATIM (writeOperation's
      // scopeKeyOverride below), so admission requires the canonical
      // grammar, not just the scope prefix: a raw delimiter or malformed
      // escape here would store a row that corrupts delimited composite
      // addressing or throws when a serving surface percent-decodes it.
      if (!isScopeKey(annotated)) {
        throw new ProtocolError(
          `derived-class commit rejected: annotated scope_key ` +
            `"${annotated}" (op ${opIndex}) is not a canonical scope_key ` +
            "(key-vocabulary.md §3)",
        );
      }
      if (scopeOfScopeKey(annotated) !== declared) {
        throw new ProtocolError(
          `derived-class commit rejected: annotated scope_key ` +
            `"${annotated}" does not match the write's declared scope ` +
            `"${declared}" (op ${opIndex})`,
        );
      }
    }
  }
  const hasPreconditions = (commit.preconditions?.length ?? 0) > 0;
  if (
    commit.operations.length === 0 && !hasPreconditions &&
    allowEmptyOperations !== true
  ) {
    throw new Error("memory v2 commit requires at least one operation");
  }

  const branch = commit.branch ?? DEFAULT_BRANCH;
  if (requireBranch(engine, branch).status !== "active") {
    throw new Error(`branch is not active: ${branch}`);
  }

  // A sessionless delegated chain has NO session instance (scopes.md
  // §5: a sessionless actor's session-scoped write is an ERROR —
  // neither falling back to another identity nor minting a session is
  // permitted). Without this refusal the writeOperation fallback
  // below would key such a write from the DELEGATING envelope's
  // session — `session:<actingPrincipal>:<sink session>`, a chimera
  // instance no party ever acted as. Refused at admission, loudly.
  // Placed AFTER the replay return (the stage-B ordering rule): the
  // check is payload-pure, so a first attempt refuses identically, and
  // a replay of a commit the store already admitted returns its stored
  // result rather than being re-adjudicated.
  if (
    delegated !== undefined &&
    (delegated.actingSession === undefined || delegated.actingSession === "")
  ) {
    // The user-scope twin under the OW15 carve-out: a USERLESS batch
    // (declared sessionless-space-scope) carrying a user-scoped write
    // would key it from the DELEGATING envelope's principal below —
    // the same chimera trap, user edition (events.md §2: user-scoped
    // writes under a sessionless event are equally an error unless
    // the event carries an acting user).
    const userless = delegated.actingPrincipal === undefined ||
      delegated.actingPrincipal === "";
    for (const operation of commit.operations) {
      if (operation.op === "sqlite") {
        // The same rule for folded SQLite writes: a session-scoped
        // cell-db resolves its on-disk file from a session identity a
        // sessionless actor does not have — admitting it would key the
        // file from the delegating ENVELOPE's session, the same
        // chimera instance the entity-write refusal below prevents.
        if (operation.db.scope === "session") {
          throw new ProtocolError(
            "delegated admission rejected: a sessionless delegated " +
              "batch (no actingSession) carries a session-scoped " +
              "SQLite write — a sessionless actor has no session " +
              "instance (scopes.md §5, protocol.md §2's delegated row)",
          );
        }
        if (userless && operation.db.scope === "user") {
          throw new ProtocolError(
            "delegated admission rejected: a userless delegated batch " +
              "carries a user-scoped SQLite write — a " +
              "sessionless-space-scope chain has no user instance " +
              "(events.md §2, scopes.md §5)",
          );
        }
        continue;
      }
      const declared = normalizeScope(operation.scope);
      if (declared === "session") {
        throw new ProtocolError(
          "delegated admission rejected: a sessionless delegated " +
            "batch (no actingSession) carries a session-scoped write " +
            "— a sessionless actor has no session instance " +
            "(scopes.md §5, protocol.md §2's delegated row)",
        );
      }
      if (userless && declared === "user") {
        throw new ProtocolError(
          "delegated admission rejected: a userless delegated batch " +
            "carries a user-scoped write — a sessionless-space-scope " +
            "chain has no user instance (events.md §2, scopes.md §5)",
        );
      }
    }
  }

  validateCommitPreconditions(engine, sessionKey, branch, commit, {
    principal,
    sessionId,
  });

  // Content-addressed documents are immutable: the content under a `cid:`
  // id can never change, so `set` is the only operation admitted against
  // one regardless of document class — a deleted or altered dependency
  // would invalidate every document referencing it — and that `set` must
  // be the first installation or content-identical to what is stored (an
  // idempotent re-`set` is how writers install closures). Admitting one
  // operation rather than refusing a named list is what holds an
  // operation added to the protocol to this rule by default.
  // Equality is `valueEqual`, canonical content-hash equality: a special
  // object's state lives in private fields a structural walk cannot see.
  // Conflicting sets of one id within a single commit are equally
  // rejected. `SessionSync.removes` are watch-result removals, not
  // deletions, and are unaffected.
  //
  // The same pass collects every schema reference the commit's content
  // introduces — a link schema anywhere in a set's document, a patch's
  // own values, a document's reserved `schema` metadata member, and an
  // installed schema document's own refs — for the closure validation
  // below. Known gap: a patch that edits INSIDE an existing link's schema
  // (replacing a `$ref` string at a sub-path, say) introduces a reference
  // no patch value carries as a whole link, so only a scan of the
  // post-patch document would see it — a cost this validation
  // deliberately does not pay. The gap closes when links become opaque
  // FabricPrimitive Link objects instead of patchable plain JSON; until
  // then such a reference escapes commit-time validation and read-side
  // assembly catches it. The scan is also
  // conservative the other way: a reference in an operand that does not
  // survive to the final document (a remove-by-value operand, an
  // add-then-remove within one commit) is still validated.
  let cidSetsInCommit: Map<string, EntityDocument> | null = null;
  // Content-identical re-sets apply as no-ops: the comparison below already
  // proves nothing changes, and writing a fresh revision anyway would
  // advance the head and fan the unchanged document out to every watcher —
  // the cost that makes blind closure re-installs expensive. The commit
  // still records (the space log advances; a client basis at its seq is
  // legal and truthful), only the per-document machinery goes quiet. The
  // set holds the content-addressed elisions this pass proves and, below
  // it, every operation of an identity commit.
  const elidedOpIndexes = new Set<number>();
  const elidableCidIds = new Set<string>();
  const requiredSchemaRefs = new Set<string>();
  // `$alias` records are NOT scanned: they are Pattern-binding vocabulary
  // only by context, and to the storage layer an `$alias`-shaped record is
  // plain data — treating its `schema` member as a schema position would
  // let a data document that merely looks like a binding reject a commit.
  // A reference a binding carries is therefore outside this boundary's
  // guarantee; readers resolve it through the realm registry and fail
  // closed when they cannot.
  const collectLinkSchemaRefs = (content: unknown): void => {
    if (!isObjectOrArray(content)) return;
    mapLinkSchemas(content as FabricValue, (schema) => {
      for (
        const hash of collectExternalSchemaRefHashes(schema as JSONSchema)
      ) {
        requiredSchemaRefs.add(hash);
      }
      return schema;
    });
  };
  const requiredLabelDocs = new Set<string>();
  // A stored CFC envelope's `schemaHash` is a schema-document reference in
  // everything but spelling: the read side assembles the label envelope
  // through `cid:<schemaHash>`, so a commit that lands metadata without
  // its document creates the same broken closure a dangling link `$ref`
  // would. Only the reserved root `cfc` member is a metadata position —
  // user data lives under `value` — and ANY non-empty string there is
  // the reference: which spellings a runner mints is not this boundary's
  // domain, so it polices backing, not format. A spelling no content can
  // verify against is simply unbackable, and a commit naming it refuses
  // here rather than reading as unreadable later.
  //
  // A version-2 envelope names labels by document as well: an entry whose
  // `label` is a single-member `{ "$ref": "cid:<hash>" }` record reads its
  // label out of that document, so the commit must back it too — by a
  // set in this commit, whose content the `cid:` rule below has already
  // verified, or by a stored document whose value hashes to the id. The
  // same policy as the schema reference, with the document's own content
  // hash as the identity check, since a label is not a schema and has no
  // closure of its own. Those hashes collect into `requiredLabelDocs`,
  // declared above the schema-reference collector so the two stay one
  // scan.
  const collectCfcEnvelopeRef = (metadata: unknown): void => {
    if (!isObjectOrArray(metadata)) return;
    const schemaHash = (metadata as { schemaHash?: unknown }).schemaHash;
    if (typeof schemaHash === "string" && schemaHash.length > 0) {
      requiredSchemaRefs.add(schemaHash);
    }
    const entries = (metadata as { labelMap?: { entries?: unknown } })
      .labelMap?.entries;
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      const label = (entry as { label?: unknown } | null)?.label;
      if (!isObjectOrArray(label)) continue;
      const keys = Object.keys(label);
      const ref = (label as { $ref?: unknown }).$ref;
      if (keys.length !== 1 || typeof ref !== "string") continue;
      if (!ref.startsWith("cid:") || ref.length === "cid:".length) {
        throw new ProtocolError(
          `memory v2 commit writes a CFC label reference \`${ref}\` outside the cid: namespace`,
        );
      }
      requiredLabelDocs.add(ref.slice("cid:".length));
    }
  };
  // A document's reserved `schema` metadata member is a schema position
  // in the link spelling — a self-contained inline schema, or a single
  // `{ "$ref": "cid:…" }` root — and its refs are collected exactly as a
  // link schema's are. The member's grammar has no third form: a `cid:`
  // reference nested inside an inline schema, or a root reference with
  // sibling keywords, is refused here, so no reader ever has to merge
  // two schema-resource scopes. Every document class carries the member
  // the same way, `cid:` documents included: content addressing hashes
  // `.value` alone, so the member is immutable and first-writer-wins
  // under the `cid:` rule below without being hash-bound, and nothing
  // distinguishes a schema document from a blob whose value happens to
  // be schema-shaped — so nothing here treats one differently.
  const collectSchemaMetaRefs = (id: string, document: unknown): void => {
    const form = classifySchemaMeta(document);
    if (form.kind === "malformed") {
      throw new ProtocolError(
        `memory v2 commit writes document ${id} with malformed schema metadata: ${form.reason}`,
      );
    }
    for (const hash of schemaMetaRefHashes(form)) requiredSchemaRefs.add(hash);
  };
  // The metadata positions a patch sequence can land a reference at —
  // directly (`/cfc`, `/cfc/schemaHash`, `/schema`), through a root-level
  // value, or by MOVING document content into a reserved member. The
  // forms compose in sequence AND across a commit's operations, so the
  // only complete answer is the post-patch document at the operation's
  // own address: replayed over what earlier operations in this commit
  // left (a set can stage the base a later patch rewrites), else over the
  // STORED document at the operation's own scope — a scoped patch never
  // lands on the space-scoped instance. Only documents some patch can
  // reach a metadata member on carry staged state, so a commit without
  // such patches pays nothing. A sequence that cannot apply is skipped
  // here — the commit's own application refuses it. A pointer BELOW
  // `/schema` edits inside a stored schema, the same shape as the
  // inside-a-link gap above, and is left to read-side assembly the same
  // way.
  const metadataPointer = (pointer: string | undefined): boolean =>
    pointer !== undefined &&
    (pointer === "" || pointer === "/cfc" || pointer.startsWith("/cfc/") ||
      pointer === `/${SCHEMA_META_MEMBER}`);
  const patchTouchesMetadata = (patches: PatchOp[] | undefined): boolean =>
    (patches ?? []).some((patch) =>
      metadataPointer(patch.path) ||
      metadataPointer("from" in patch ? patch.from : undefined)
    );
  // Scoped rows key exactly as the write loop below keys them: a
  // delegated commit's scoped writes carry the validated acting identity,
  // and a derived commit's annotation supplies the row key outright.
  const scanPrincipal = delegated?.actingPrincipal ?? principal;
  const scanSession = delegated?.actingSession ?? sessionId;
  const opDocKey = (
    opIndex: number,
    operation: { id: string; scope?: unknown },
  ): string =>
    `${operation.id}|${
      scopeKeyByOpIndex.get(opIndex) ??
        resolveScopeKey(
          operation.scope as Parameters<typeof resolveScopeKey>[0],
          {
            principal: scanPrincipal,
            sessionId: scanSession,
          },
        )
    }`;
  const metadataPatchDocKeys = new Set<string>();
  for (const [opIndex, operation] of commit.operations.entries()) {
    if (operation.op !== "patch" || operation.id.startsWith("cid:")) continue;
    if (patchTouchesMetadata(operation.patches)) {
      metadataPatchDocKeys.add(opDocKey(opIndex, operation));
    }
  }
  const stagedMetadataDocs = new Map<string, unknown>();
  for (const [opIndex, operation] of commit.operations.entries()) {
    if (operation.op === "sqlite") continue;
    if (operation.op === "patch") {
      for (const patch of operation.patches ?? []) {
        if ("value" in patch) collectLinkSchemaRefs(patch.value);
        if ("add" in patch) collectLinkSchemaRefs(patch.add);
        if ("values" in patch) collectLinkSchemaRefs(patch.values);
      }
      if (metadataPatchDocKeys.size > 0) {
        const docKey = opDocKey(opIndex, operation);
        if (metadataPatchDocKeys.has(docKey)) {
          const base = stagedMetadataDocs.has(docKey)
            ? stagedMetadataDocs.get(docKey)
            : readState(engine, {
              id: operation.id,
              branch,
              scope: operation.scope as Parameters<
                typeof readState
              >[1]["scope"],
              principal: scanPrincipal,
              sessionId: scanSession,
              scopeKey: scopeKeyByOpIndex.get(opIndex),
            })?.document ?? undefined;
          try {
            const patched = applyPatchToDocument(
              base as Parameters<typeof applyPatchToDocument>[0] | undefined,
              operation.patches ?? [],
            );
            stagedMetadataDocs.set(docKey, patched);
            if (patchTouchesMetadata(operation.patches)) {
              collectCfcEnvelopeRef((patched as { cfc?: unknown }).cfc);
              collectSchemaMetaRefs(operation.id, patched);
            }
          } catch (error) {
            if (!(error instanceof PatchApplyError)) throw error;
          }
        }
      }
    }
    if (!operation.id.startsWith("cid:")) {
      if (operation.op === "set") {
        collectLinkSchemaRefs(operation.value);
        collectCfcEnvelopeRef(
          (operation.value as { cfc?: unknown } | null)?.cfc,
        );
        collectSchemaMetaRefs(operation.id, operation.value);
        if (metadataPatchDocKeys.size > 0) {
          const docKey = opDocKey(opIndex, operation);
          if (metadataPatchDocKeys.has(docKey)) {
            stagedMetadataDocs.set(docKey, operation.value);
          }
        }
      }
      if (operation.op === "delete" && metadataPatchDocKeys.size > 0) {
        const docKey = opDocKey(opIndex, operation);
        if (metadataPatchDocKeys.has(docKey)) {
          stagedMetadataDocs.set(docKey, undefined);
        }
      }
      continue;
    }
    if (operation.op !== "set") {
      throw new ProtocolError(
        `memory v2 commit cannot ${operation.op} content-addressed document ${operation.id}`,
      );
    }
    // Content-addressed documents live at space scope only: a scoped
    // partition could hold a divergent copy under the same id (the
    // immutability check reads at the operation's scope, so a scoped set
    // reads an empty partition and passes as a first installation), and
    // every reader resolves `cid:` documents at space scope. One id, one
    // content, one partition.
    if (normalizeScope(operation.scope) !== DEFAULT_SCOPE) {
      throw new ProtocolError(
        `memory v2 commit cannot write content-addressed document ${operation.id} at ${operation.scope} scope`,
      );
    }
    // A set's value must be a document object, as applying the set also
    // checks. It is checked here first because the identity check below reads
    // its `value` member, which on a non-document can be anything: a
    // `FabricRegExp`'s, for one, is a JS `RegExp`.
    if (!isEntityDocument(operation.value)) {
      throw new ProtocolError(
        `memory v2 commit sets content-addressed document ${operation.id} to something other than a document`,
      );
    }
    // A `cid:` set must be the content its id names: the general content
    // hash of its value, which is the identity of a code document's
    // string, of any other content, and of a schema document alike (a
    // schema's interned hash is this same hash over the deep-frozen
    // schema, so nothing is interned here). Content that does not hash to
    // its id is refused below, after the two comparisons that name a more
    // specific fault, so the namespace holds nothing a reader cannot
    // verify. A schema-shaped document contributes its own refs and is
    // never link-scanned, since keywords such as `default` may carry
    // link-shaped DATA; other content is scanned like an ordinary
    // document.
    const installedInner = operation.value.value;
    const installedHash = operation.id.slice("cid:".length);
    const installsSchemaShape = isSubschema(installedInner);
    const installsVerifiedContent =
      taggedHashStringOf(installedInner) === installedHash;
    if (installsVerifiedContent && installsSchemaShape) {
      for (const hash of collectExternalSchemaRefHashes(installedInner)) {
        requiredSchemaRefs.add(hash);
      }
    } else if (installsVerifiedContent) {
      collectLinkSchemaRefs(operation.value);
    }
    // The envelope's `schema` metadata member is validated for every
    // `cid:` document alike (see collectSchemaMetaRefs): the identity
    // check above covers `.value` and nothing beside it.
    if (installsVerifiedContent) {
      collectSchemaMetaRefs(operation.id, operation.value);
    }
    const earlierSet = cidSetsInCommit?.get(operation.id);
    if (earlierSet !== undefined) {
      if (!valueEqual(earlierSet, operation.value)) {
        throw new ProtocolError(
          `memory v2 commit carries conflicting sets of content-addressed document ${operation.id}`,
        );
      }
      // A duplicate of a stored-identical set elides with it; a duplicate
      // within a first install keeps today's write-both behavior.
      if (elidableCidIds.has(operation.id)) {
        elidedOpIndexes.add(opIndex);
      }
      continue;
    }
    const stored = read(engine, {
      id: operation.id,
      branch,
      scope: operation.scope,
      principal,
      sessionId,
    });
    if (stored !== null) {
      if (!valueEqual(stored, operation.value)) {
        throw new ProtocolError(
          `memory v2 commit cannot change content-addressed document ${operation.id}`,
        );
      }
      elidedOpIndexes.add(opIndex);
      elidableCidIds.add(operation.id);
    }
    if (!installsVerifiedContent) {
      throw new ProtocolError(
        `memory v2 commit installs content-addressed document ${operation.id} whose content does not hash to its id`,
      );
    }
    (cidSetsInCommit ??= new Map()).set(operation.id, operation.value);
  }

  // Commit-time closure validation: every schema reference the scan
  // above collects must be backed by a VERIFIED schema document —
  // installed by this same commit or already stored in the space — and
  // so must the whole closure behind it. With this, the commit API
  // cannot create a broken or forged closure for any reference the scan
  // sees: an assembly failure downstream means the patch gap documented
  // above, out-of-band tampering, or a store that predates this
  // validation.
  if (requiredSchemaRefs.size > 0) {
    const cache = schemaDocCache(engine);
    // The hashes this commit's own sets backed, for the refusal's wording,
    // and the seq each stored document was read at, for the cache.
    const included = new Set<string>();
    const storedSeqs = new Map<string, number>();
    walkSchemaDocumentClosure({
      roots: requiredSchemaRefs,
      load: (hash) => {
        const id = `cid:${hash}`;
        const installed = cidSetsInCommit?.get(id)?.value;
        if (installed !== undefined) {
          included.add(hash);
          // The set already verified its content against its id; what a
          // schema reference additionally requires is that the content be
          // a schema at all — a code document's string, say, is not, and
          // handing it over as stored content is what refuses it.
          return isSubschema(installed)
            ? { kind: "verified", schema: installed }
            : { kind: "stored", value: installed };
        }
        const state = readState(engine, { id, branch });
        const cached = cache.get(id);
        if (cached !== undefined && cached.seq === state?.seq) {
          return { kind: "verified", schema: cached.schema };
        }
        const storedInner =
          state?.document === null || state?.document === undefined
            ? undefined
            : (state.document as { value?: unknown }).value;
        if (storedInner === undefined) return undefined;
        storedSeqs.set(hash, state!.seq);
        return { kind: "stored", value: storedInner };
      },
      onVerified: (hash, schema) => {
        const seq = storedSeqs.get(hash);
        if (seq === undefined) return;
        if (cache.size >= SCHEMA_DOC_CACHE_MAX_ENTRIES) {
          cache.clear();
        }
        cache.set(`cid:${hash}`, { seq, schema });
      },
      onMissing: (hash, miss) => {
        const id = `cid:${hash}`;
        if (miss === "absent") {
          throw new ProtocolError(
            `memory v2 commit references schema document ${id} that is neither included in the commit nor stored in the space`,
          );
        }
        throw new ProtocolError(
          included.has(hash)
            ? `memory v2 commit references schema document ${id} whose included content does not verify`
            : `memory v2 commit references schema document ${id} whose stored content does not verify`,
        );
      },
    });
  }

  // A label document's content is a record whose every member is
  // `confidentiality` or `integrity` holding an array. The hash alone
  // cannot tell a label from a record that merely verifies, and a reader
  // resolving a malformed one would fail closed on every read of the
  // envelope, so the shape is refused here, where the writer can act on it.
  const isLabelDocumentShape = (value: unknown): boolean =>
    isObjectNotArray(value) &&
    Object.entries(value).every(([key, member]) =>
      (key === "confidentiality" || key === "integrity") &&
      Array.isArray(member)
    );
  for (const hash of requiredLabelDocs) {
    const id = `cid:${hash}`;
    // A set in this commit reached here with its content verified against
    // its id, so what remains to check of it is the shape.
    const installed = cidSetsInCommit?.get(id)?.value;
    const state = installed === undefined
      ? readState(engine, { id, branch })
      : undefined;
    const storedInner = state?.document === null ||
        state?.document === undefined
      ? undefined
      : state.document.value;
    const content = installed ?? storedInner;
    if (content === undefined) {
      throw new ProtocolError(
        `memory v2 commit references CFC label document ${id} that is neither included in the commit nor stored in the space`,
      );
    }
    if (installed === undefined && taggedHashStringOf(storedInner) !== hash) {
      throw new ProtocolError(
        `memory v2 commit references CFC label document ${id} whose stored content does not verify`,
      );
    }
    if (!isLabelDocumentShape(content)) {
      throw new ProtocolError(
        `memory v2 commit references CFC label document ${id} whose content does not hold a label`,
      );
    }
  }

  // An identity commit leaves every document it writes as the space
  // already holds it, so applying the commit changes nothing. A commit that
  // changes nothing cannot have observed anything wrongly in a way that
  // matters, so its reads' staleness is not checked (03-commit-model.md
  // §3.6.1) and every operation elides like a content-addressed re-set.
  // Only the staleness scan is waived: a pending read naming an unresolved
  // or rejected layer still refuses the commit, which is what keeps the
  // client's cascade and the server's verdict in agreement (09-invariants.md,
  // INV-4 and INV-6). Every comparison reads the stored document under the
  // same identity the write would apply under, so a scoped instance
  // compares against its own partition.
  //
  // The proof is per document, over the commit's `set` and `patch`
  // operations on it in order: replayed on the document as the commit's
  // read of it saw it, the sequence yields the stored document, and
  // replayed on the stored document it leaves that unchanged. The second
  // condition is for the writer's own replica, which re-folds the
  // operations over whatever confirmed base it holds when the accept
  // arrives: a sequence idempotent on the durable value lands on that value
  // from any base between the read and the head, where a positional splice
  // replayed over a base already carrying its elements would duplicate
  // them.
  type DocumentOps = Array<
    Extract<typeof commit.operations[number], { op: "set" | "patch" }>
  >;
  const replay = (
    base: EntityDocument | undefined,
    operations: DocumentOps,
  ): EntityDocument | undefined => {
    let document = base;
    for (const operation of operations) {
      document = operation.op === "set"
        ? operation.value as EntityDocument
        : applyPatchToDocument(document, operation.patches);
    }
    return document;
  };
  // The document as the commit's read of it saw it, on the commit's branch
  // under the write's scope. A pending read is the view the value came
  // through: the document at the read's declared confirmed basis with
  // exactly the own layers the read names replayed on it in local order.
  // The layers' resolution seqs would not do: the durable document at the
  // highest one carries every foreign write on other paths that landed
  // before it, which the reader had not integrated, so a patch judged from
  // there could pass as an identity while the reader's own view would not
  // have produced the stored document. A pending read that declares no
  // basis (a legacy client) leaves the view unreconstructable, and such a
  // commit gets no exemption. Where a commit also carries a confirmed read
  // of the same document (a shape-only read that names the non-speculative
  // stack), the pending read decides. A confirmed read's view is the
  // document at its seq. A read names its branch only when that differs
  // from the commit's, exactly as the staleness check reads it; a read
  // that names another branch says nothing about this one and is passed
  // over. A basis below the branch's creation seq is not a state of this
  // branch (06-branching.md §6.10.1), so such a read leaves the view
  // unreconstructable as well. With no read of the document at all the
  // sequence is an identity only where it is idempotent, so the stored
  // document is the basis.
  type Basis =
    | { known: true; document: EntityDocument | undefined }
    | { known: false };
  const REPLAYABLE_LAYER_OPS = new Set(["set", "patch", "delete"]);
  const branchCreatedSeq = branch === DEFAULT_BRANCH
    ? 0
    : getBranch(engine, branch)?.createdSeq ?? Number.POSITIVE_INFINITY;
  const basisOf = (
    first: DocumentOps[number],
    stored: EntityDocument,
    at: (seq: number) => EntityDocument | null,
  ): Basis => {
    const sameDocument = (candidate: { id: string; scope?: unknown }) =>
      candidate.id === first.id &&
      normalizeScope(
          candidate.scope as Parameters<typeof normalizeScope>[0],
        ) ===
        normalizeScope(first.scope);
    const documentAt = (seq: number): EntityDocument | undefined =>
      seq === 0 ? undefined : at(seq) ?? undefined;
    const pending = commit.reads.pending.find(sameDocument);
    if (pending !== undefined) {
      if (
        pending.basisSeq === undefined || pending.basisSeq < branchCreatedSeq
      ) {
        return { known: false };
      }
      let document = documentAt(pending.basisSeq);
      const layers = [...pendingReadLayers(pending)].sort((a, b) => a - b);
      for (const localSeq of layers) {
        const row = engine.statements.selectExistingCommit.get({
          session_id: sessionKey,
          local_seq: localSeq,
        }) as CommitRow | undefined;
        if (row === undefined || (row.branch || DEFAULT_BRANCH) !== branch) {
          return { known: false };
        }
        const layer = decodeMemoryBoundary(row.original) as ClientCommit;
        for (const operation of layer.operations) {
          if (operation.op === "sqlite" || !sameDocument(operation)) continue;
          // An op-field operation on the document is not replayable here.
          if (!REPLAYABLE_LAYER_OPS.has(operation.op)) return { known: false };
          document = operation.op === "delete"
            ? undefined
            : replay(document, [operation as DocumentOps[number]]);
        }
      }
      return { known: true, document };
    }
    const confirmed = commit.reads.confirmed.find((candidate) =>
      sameDocument(candidate) && (candidate.branch ?? branch) === branch
    );
    if (confirmed === undefined) return { known: true, document: stored };
    if (confirmed.seq < branchCreatedSeq) return { known: false };
    return { known: true, document: documentAt(confirmed.seq) };
  };
  // Proving the identity reads the stored document and, for a patch, the
  // document at the reader's basis, so it runs only once a staleness check
  // has refused the commit: the cost lands on the refusal path alone, and
  // a commit that validates never materializes a revision it did not need.
  // The proof is per document, over every operation the commit applies to
  // it in order: a commit that creates a document with a `set` and then
  // patches it is one write of the final value, and only the replay of the
  // whole sequence can compare with what is stored.
  const isIdentityCommit = (): boolean => {
    if (commit.operations.length === 0) return false;
    type DocOps = { opIndex: number; operations: DocumentOps };
    const byDocument = new Map<string, DocOps>();
    for (const [opIndex, operation] of commit.operations.entries()) {
      if (operation.op !== "set" && operation.op !== "patch") return false;
      // A space's ACL document, the one entity named by a DID, has its own
      // admission (09-invariants.md, INV-12 and INV-13): a genesis that
      // loses its race is refused so that one commit is the genesis, and an
      // identical re-seal recorded as a no-op would be a second.
      if (operation.id.startsWith("of:did:")) return false;
      if (operation.id.startsWith("cid:")) {
        if (!elidedOpIndexes.has(opIndex)) return false;
        continue;
      }
      const key = opDocKey(opIndex, operation);
      const group = byDocument.get(key);
      if (group === undefined) {
        byDocument.set(key, { opIndex, operations: [operation] });
      } else {
        group.operations.push(operation);
      }
    }
    for (const { opIndex, operations } of byDocument.values()) {
      const first = operations[0];
      const at = (seq?: number) =>
        read(engine, {
          id: first.id,
          branch,
          seq,
          scope: first.scope,
          principal: scanPrincipal,
          sessionId: scanSession,
          scopeKey: scopeKeyByOpIndex.get(opIndex),
        });
      const stored = at();
      if (stored === null) return false;
      // A view that cannot be reconstructed, or a patch that cannot be
      // applied to one of the two bases, proves no identity, and the
      // staleness refusal the commit arrived with stands; the ordinary
      // apply path reports a patch's own failure on the retry.
      try {
        const basis = basisOf(first, stored, at);
        if (!basis.known) return false;
        const fromBasis = replay(basis.document, operations);
        const onStored = replay(stored, operations);
        if (
          !valueEqual(fromBasis as FabricValue, stored as FabricValue) ||
          !valueEqual(onStored as FabricValue, stored as FabricValue)
        ) {
          return false;
        }
      } catch {
        return false;
      }
    }
    return true;
  };
  let resolvedPendingReads: Array<{ localSeq: number; seq: number }>;
  try {
    validateConfirmedReads(engine, branch, commit, { principal, sessionId });
    resolvedPendingReads = resolvePendingReads(
      engine,
      sessionKey,
      sessionId,
      principal,
      branch,
      commit,
    );
  } catch (error) {
    // Only a staleness refusal has an identity escape. A refusal for an
    // unresolved or rejected dependency carries no conflict seq and stands.
    if (
      !(error instanceof ConflictError) || error.conflictSeq === undefined ||
      !isIdentityCommit()
    ) {
      throw error;
    }
    for (const opIndex of commit.operations.keys()) {
      elidedOpIndexes.add(opIndex);
    }
    resolvedPendingReads = resolvePendingReads(
      engine,
      sessionKey,
      sessionId,
      principal,
      branch,
      commit,
      { checkStaleness: false },
    );
  }

  // Event-append admission (Phase 3, events.md §1/§4): the dedupe-horizon
  // CAS, the firedAt validation-or-stamp, and the sidecar write guard.
  // AFTER the replay short-circuit (a replayed append returns its stored
  // result — the original admission stamped it; re-running the CAS here
  // would wrongly reject the replay as its own duplicate) and before the
  // seq allocation; the stamps apply per-op in the write loop below.
  const eventAppendPlan = validateEventAppends(engine, {
    commit,
    commitClass,
    branch,
    principal,
    sessionId,
    delegated,
    systemEventActor,
    scopeKeyByOpIndex,
  });

  const seq = (engine.statements.selectNextSeq.get() as { seq: number }).seq;
  const invocationRef = engine.legacyCommitMetadataRefsRequired
    ? LEGACY_EMPTY_INVOCATION_REF
    : null;
  const authorizationRef = engine.legacyCommitMetadataRefsRequired
    ? LEGACY_EMPTY_AUTHORIZATION_REF
    : null;
  const original = encodeMemoryBoundary(commit);
  const resolution = encodeMemoryBoundary(
    resolvedPendingReads.length > 0 ? { seq, resolvedPendingReads } : { seq },
  );

  if (engine.legacyCommitMetadataRefsRequired) {
    engine.statements.insertAuthorization.run({
      ref: LEGACY_EMPTY_AUTHORIZATION_REF,
      authorization: encodeMemoryBoundary(LEGACY_EMPTY_AUTHORIZATION),
    });
    engine.statements.insertInvocation.run({
      ref: LEGACY_EMPTY_INVOCATION_REF,
      iss: LEGACY_EMPTY_INVOCATION.iss,
      aud: LEGACY_EMPTY_INVOCATION.aud ?? null,
      cmd: LEGACY_EMPTY_INVOCATION.cmd,
      sub: LEGACY_EMPTY_INVOCATION.sub,
      invocation: encodeMemoryBoundary(LEGACY_EMPTY_INVOCATION),
    });
  }
  engine.statements.insertCommit.run({
    seq,
    branch,
    session_id: sessionKey,
    local_seq: commit.localSeq,
    invocation_ref: invocationRef,
    authorization_ref: authorizationRef,
    original,
    resolution,
    class: commitClass,
    holder: commitClass === "derived" ? holder ?? null : null,
    annotations: commitClass === "derived" && annotations !== undefined &&
        annotations.length > 0
      ? encodeMemoryBoundary(annotations)
      : null,
    consequence_of: commitClass === "derived" && consequenceOf !== undefined &&
        consequenceOf.length > 0
      ? encodeMemoryBoundary(consequenceOf)
      : null,
    derived_through: commitClass === "derived" && derivedThrough !== undefined
      ? derivedThrough
      : null,
    // `|| null`, not `?? null`: a declared sessionless-space-scope batch
    // arrives with an EMPTY acting principal (the delivery path's
    // carriage normalization) and stores NULL — "no actor", never "".
    acting_principal: delegated?.actingPrincipal || null,
    acting_session: delegated?.actingSession || null,
    capability_ref: delegated?.capabilityRef ?? null,
  });

  const revisions: AppliedRevision[] = [];
  const operationResolutions: ApplyOpResolution[] = [];
  for (const [opIndex, operation] of commit.operations.entries()) {
    if (operation.op === "sqlite") {
      // Execute the SQL inside this commit's transaction (atomic with the cell
      // ops). It is NOT an entity revision — do not push to `revisions[]` so the
      // revision/head/snapshot/dirty machinery never sees it.
      try {
        applySqliteOperation(engine, operation, sqliteAttachments, {
          principal,
          sessionId,
        });
      } catch (error) {
        if (
          error instanceof RowLabelCommitError &&
          error.operationIndex === undefined
        ) {
          error.operationIndex = opIndex;
        }
        throw error;
      }
      continue;
    }
    if (operation.op === "apply-op") {
      const applied = applyOperation(engine, {
        branch,
        seq,
        opIndex,
        operation,
        principal: scanPrincipal,
        sessionId: scanSession,
        scopeKeyOverride: scopeKeyByOpIndex.get(opIndex),
      });
      operationResolutions.push(applied.resolution);
      if (applied.revision) revisions.push(applied.revision);
      continue;
    }
    if (operation.op === "release-op-field") {
      releaseOperationField(engine, {
        branch,
        operation,
        principal: scanPrincipal,
        sessionId: scanSession,
        scopeKeyOverride: scopeKeyByOpIndex.get(opIndex),
      });
      continue;
    }
    if (operation.op === "delete") {
      releaseEntityOperationFields(
        engine,
        branch,
        operation.id,
        scopeKeyByOpIndex.get(opIndex) ??
          resolveScopeKey(operation.scope, {
            principal: scanPrincipal,
            sessionId: scanSession,
          }),
      );
    } else {
      assertOperationFieldsPreserved(engine, {
        branch,
        operation,
        principal: scanPrincipal,
        sessionId: scanSession,
        scopeKeyOverride: scopeKeyByOpIndex.get(opIndex),
      });
    }
    if (elidedOpIndexes.has(opIndex)) continue;
    // Event-append stamping (Phase 3): a declared append's entry gets its
    // stream `seq` (this commit's) and admission-resolved `firedAt`
    // written into a CLONE of the op — the caller's operation objects are
    // shared with replica overlays and stay pristine; `original` (encoded
    // above, pre-stamp) records the as-received payload so replay
    // comparison stays stable.
    const stamps = eventAppendPlan.get(opIndex);
    const appendStamped = stamps === undefined
      ? operation
      : stampEventAppendOperation(operation, stamps, seq);
    // The effects-doc transform (Phase 4, protocol.md §5): a
    // derived-class write of the well-known effects doc gets its intent
    // entries' `issuedIn` sentinels stamped with this commit's seq and
    // its APPENDS deduped by stored nonce — see
    // transformEffectsDocOperation.
    const effectiveOperation = commitClass === "derived" &&
        appendStamped.id === SERVER_EXECUTION_EFFECTS_DOC_ID
      ? transformEffectsDocOperation(engine, appendStamped, seq, {
        branch,
        scopeKey: scopeKeyByOpIndex.get(opIndex),
      })
      : appendStamped;
    const revision = writeOperation(engine, {
      branch,
      seq,
      opIndex,
      operation: effectiveOperation,
      // A delegated commit's scoped writes key from the validated CARRIED
      // identity (protocol.md §2's delegated row; scopes.md §5 —
      // consequences land in the ACTOR's instances, never the delegating
      // envelope's; stamping from the envelope would be the
      // silent-empty-instance trap, cross-space edition). The
      // `?? sessionId` fallback is safe ONLY because admission above
      // refuses a sessionless delegated batch carrying a session-scoped
      // op: for the ops that reach here under a sessionless delegation,
      // no session component enters the key.
      principal: delegated?.actingPrincipal ?? principal,
      sessionId: delegated?.actingSession ?? sessionId,
      scopeKeyOverride: scopeKeyByOpIndex.get(opIndex),
    });
    revisions.push(revision);
  }

  if (operationResolutions.length > 0) {
    engine.statements.updateCommitResolution.run({
      seq,
      resolution: encodeMemoryBoundary({
        seq,
        ...(resolvedPendingReads.length > 0 ? { resolvedPendingReads } : {}),
        operationResolutions,
      }),
    });
  }

  validateStoredSyncSchemaRefs(engine, branch, revisions, original);

  // Per-stream `eventWatermark` maintenance (Phase 3; events.md §4): a
  // DERIVED commit that touched a stream sidecar has its watermark
  // recomputed HERE, inside the commit's own transaction — the
  // consequence marks and the advance are atomic by construction, and a
  // requeued entry (whose mark rolled back with its contribution) holds
  // the frontier. The frontier is the model's rule verbatim: ADVANCE
  // the stored value to the highest seq S such that every entry above
  // the stored value and at or below S is consequenced; entries
  // sharing one commit seq advance only together. Seq-less entries
  // (the stage-G interim arm) hold no frontier position — their dedupe
  // rides the consequenced flag alone. The STORED value is the floor,
  // exactly as in the model (`commitWave`'s `let wm =
  // st.eventWatermark`): the recompute never lowers it, so a derived
  // producer that wrote a too-high watermark is trusted — the accepted
  // single-deriver threat posture (only the lease holder commits
  // derived; watermark forgery is protocol.md §1's accepted authored
  // intrusion, and this is its derived twin).
  if (commitClass === "derived") {
    maintainStreamEventWatermarks(engine, branch, seq, sessionId, revisions);
  }

  runBranchWrite(engine, engine.statements.updateBranchHead, { branch, seq });
  materializeSnapshots(engine, branch, revisions);

  return {
    seq,
    branch,
    revisions,
    ...(operationResolutions.length > 0 ? { operationResolutions } : {}),
    ...(elidedOpIndexes.size > 0
      ? {
        elidedOpIndexes: [...elidedOpIndexes].toSorted((a, b) => a - b),
      }
      : {}),
  };
};

/** The events.md §4 frontier recompute (see the call site above): runs
 * once per touched sidecar doc, reading the post-apply state within the
 * same transaction. */
const maintainStreamEventWatermarks = (
  engine: Engine,
  branch: BranchName,
  seq: number,
  sessionId: SessionId,
  revisions: AppliedRevision[],
): void => {
  const touched = new Map<string, AppliedRevision>();
  for (const revision of revisions) {
    if (isStreamEntriesDocId(revision.id)) {
      touched.set(`${revision.id}\0${revision.scopeKey}`, revision);
    }
  }
  // Synthetic ops slot BEYOND the commit's own highest revision opIndex
  // — NOT `revisions.length` (verdict blocker, 2026-08-12): sqlite ops
  // consume operation indices without pushing revisions, so for
  // `[sqlite, sidecar]` the length re-uses the sidecar revision's own
  // index and the (seq, op_index) primary key collides, rolling back
  // the whole wave. Max+1 is collision-free: entity revisions occupy
  // exactly their operation indices, and sqlite slots write no
  // revision rows.
  let nextSyntheticOpIndex =
    revisions.reduce((max, r) => Math.max(max, r.opIndex), -1) + 1;
  for (const revision of touched.values()) {
    const state = readStateForScopeKey(engine, {
      id: revision.id,
      branch,
      scope: normalizeScope(revision.scope),
      scopeKey: revision.scopeKey,
    });
    const document = state?.document;
    const value = document?.value as StreamEventsDocValue | undefined;
    if (value === undefined || document === null) continue;
    // Defensive (M1/m4, review 2026-08-11): a malformed (non-array)
    // log must not TypeError the recompute — and with it the whole
    // derived commit's apply transaction.
    const entries = (Array.isArray(value.entries) ? value.entries : [])
      .filter(
        (entry): entry is StreamEventEntry => isObjectOrArray(entry),
      );
    const stored = typeof value.eventWatermark === "number"
      ? value.eventWatermark
      : 0;
    const seqs = [
      ...new Set(
        entries
          .map((entry) => entry.seq)
          .filter((entrySeq): entrySeq is number =>
            typeof entrySeq === "number"
          ),
      ),
    ].sort((a, b) => a - b);
    let frontier = stored;
    for (const entrySeq of seqs) {
      if (entrySeq <= frontier) continue;
      if (
        entries
          .filter((entry) => entry.seq === entrySeq)
          .every((entry) => entry.consequenced === true)
      ) {
        frontier = entrySeq;
      } else {
        break;
      }
    }
    if (
      frontier ===
        (typeof value.eventWatermark === "number"
          ? value.eventWatermark
          : undefined)
    ) {
      continue;
    }
    // A synthetic op BEYOND the commit's own operations (op_index is
    // unique per (seq, opIndex); see nextSyntheticOpIndex above). The
    // returned revision JOINS the commit's revision list: snapshot
    // materialization, head maintenance, and subscriber push all ride
    // it.
    revisions.push(writeOperation(engine, {
      branch,
      seq,
      opIndex: nextSyntheticOpIndex++,
      operation: {
        op: "patch",
        id: revision.id as never,
        ...(revision.scope !== undefined ? { scope: revision.scope } : {}),
        patches: [{
          op: "replace",
          path: "/value/eventWatermark",
          value: frontier as never,
        }],
      },
      sessionId,
      scopeKeyOverride: revision.scopeKey,
    }));
  }
};

/**
 * Apply a folded `sqlite` op inside the commit transaction. The target cell-db
 * must already be ATTACHed by the caller (server, before applyCommit) under the
 * alias in `attachments`; unqualified names in the SQL resolve to it. Throwing
 * here (e.g. the guard rejecting DDL, or a commit-time row-label violation)
 * rolls back the whole commit.
 */
const applySqliteOperation = (
  engine: Engine,
  op: SqliteOperation,
  attachments: ReadonlyMap<string, string> | undefined,
  commitScope: { principal?: string; sessionId: SessionId },
): void => {
  // The server attaches exactly one cell-db (under an alias) before applyCommit;
  // assert it's present, then run the statement UNQUALIFIED. Unqualified table
  // names resolve to that single attached db — the ≤1-cell-db-per-commit rule
  // (#attachCommitSqliteDbs) plus the core-table guard prevent ambiguity, so the
  // alias is not used to qualify the SQL here (only the presence matters).
  if (!attachments?.has(op.db.id)) {
    throw new ProtocolError(
      `sqlite op for db ${op.db.id} has no attachment (server must attach before applyCommit)`,
    );
  }
  // Plain guarded write — except when the db declares a per-row label rule, in
  // which case the affected rows are read back and re-derived through the
  // shared evaluator, rolling back the commit on any violation (CFC Phase 3.c;
  // see sqlite/commit-eval.ts).
  applySqliteCommitWrite(
    engine.database,
    resolveSqliteOpOwner(engine, op, commitScope),
  );
};

/**
 * Backfill `db.owner` (the `dbOwner()` evaluation input) for a rule-bearing
 * sqlite op that arrived without it — a pre-3.c client's `db.exec` never sent
 * the field, and its writes must not start failing on `dbOwner()` rules under
 * a server-first rolling upgrade. The db handle CELL (`op.db.id`) carries the
 * owner stamped at creation — the same value the read side resolves — so a
 * value read of the committed handle doc recovers it. The handle doc lives at
 * the db's DECLARED scope (`op.db.scope`), so the read is resolved with that
 * scope plus the commit's principal / session — a `user`/`session`-scoped
 * handle is missed by a default-scope read. Best-effort and fail-closed: a
 * missing doc / owner (or a scoped handle whose scope key can't be resolved,
 * e.g. an anonymous commit lacking a principal) leaves the op unchanged, and a
 * `dbOwner()` rule then refuses as before.
 */
const resolveSqliteOpOwner = (
  engine: Engine,
  op: SqliteOperation,
  commitScope: { principal?: string; sessionId: SessionId },
): SqliteOperation => {
  if (
    op.db.owner !== undefined || op.db.tables === undefined ||
    !Object.values(op.db.tables).some(tableDeclaresRowLabel)
  ) {
    return op;
  }
  // `resolveScopeKey` (inside `read`) throws for a user/session scope missing a
  // principal/session — a best-effort backfill must not abort the commit, so
  // fail closed to the unchanged op instead.
  let doc: EntityDocument | null;
  try {
    doc = read(engine, {
      id: op.db.id,
      scope: op.db.scope,
      principal: commitScope.principal,
      sessionId: commitScope.sessionId,
    });
  } catch {
    return op;
  }
  const owner = (doc?.value as { owner?: unknown } | undefined)?.owner;
  return typeof owner === "string" ? { ...op, db: { ...op.db, owner } } : op;
};

const writeOperation = (
  engine: Engine,
  options: {
    branch: BranchName;
    seq: number;
    opIndex: number;
    operation: SetOperation | PatchOperation | DeleteOperation;
    principal?: string;
    sessionId: SessionId;

    /** The explicit scope_key of a derived commit's scoped write
     * (protocol.md §1's ADDRESSING): admission validated it against the
     * declared scope; when present it keys the row instead of a
     * session-derived resolution — the service envelope has no session to
     * resolve from. */
    scopeKeyOverride?: string;
  },
): AppliedRevision => {
  const { branch, seq, opIndex, operation, principal, sessionId } = options;
  const scope = normalizeScope(operation.scope);
  const scopeKey = options.scopeKeyOverride ??
    resolveScopeKey(operation.scope, { principal, sessionId });
  const revisionScopeFields = scope === DEFAULT_SCOPE
    ? { scopeKey }
    : { scope, scopeKey };
  switch (operation.op) {
    case "set": {
      if (!isEntityDocument(operation.value)) {
        throw new Error(
          "memory v2 set operations require explicit document objects",
        );
      }
      engine.statements.insertRevision.run({
        branch,
        id: operation.id,
        scope_key: scopeKey,
        seq,
        op_index: opIndex,
        op: "set",
        data: encodeMemoryBoundary(operation.value),
        commit_seq: seq,
      });
      engine.statements.upsertHead.run({
        branch,
        id: operation.id,
        scope_key: scopeKey,
        seq,
        op_index: opIndex,
        op: "set",
      });
      return {
        id: operation.id,
        ...revisionScopeFields,
        branch,
        seq,
        opIndex,
        commitSeq: seq,
        op: "set",
        document: operation.value,
      };
    }
    case "patch": {
      engine.statements.insertRevision.run({
        branch,
        id: operation.id,
        scope_key: scopeKey,
        seq,
        op_index: opIndex,
        op: "patch",
        data: encodeMemoryBoundary(operation.patches),
        commit_seq: seq,
      });
      engine.statements.upsertHead.run({
        branch,
        id: operation.id,
        scope_key: scopeKey,
        seq,
        op_index: opIndex,
        op: "patch",
      });
      return {
        id: operation.id,
        ...revisionScopeFields,
        branch,
        seq,
        opIndex,
        commitSeq: seq,
        op: "patch",
        patches: operation.patches,
      };
    }
    case "delete": {
      engine.statements.insertRevision.run({
        branch,
        id: operation.id,
        scope_key: scopeKey,
        seq,
        op_index: opIndex,
        op: "delete",
        data: null,
        commit_seq: seq,
      });
      engine.statements.upsertHead.run({
        branch,
        id: operation.id,
        scope_key: scopeKey,
        seq,
        op_index: opIndex,
        op: "delete",
      });
      return {
        id: operation.id,
        ...revisionScopeFields,
        branch,
        seq,
        opIndex,
        commitSeq: seq,
        op: "delete",
      };
    }
  }
};

const validateCommitPreconditions = (
  engine: Engine,
  sessionKey: string,
  branch: BranchName,
  commit: ClientCommit,
  scopeContext: { principal?: string; sessionId: SessionId },
): void => {
  for (const precondition of commit.preconditions ?? []) {
    // Wire input: validate the shape deterministically so malformed entries
    // surface as ProtocolError instead of a TypeError-turned-TransactionError.
    if (!isObjectNotArray(precondition)) {
      throw new ProtocolError("malformed commit precondition: not an object");
    }
    switch (precondition.kind) {
      case "origin-committed": {
        if (!Number.isInteger(precondition.originLocalSeq)) {
          throw new ProtocolError(
            "malformed origin-committed precondition: originLocalSeq must be an integer",
          );
        }
        // Same-session commits are applied in order, so the origin's fate is
        // decided when the follow-up arrives; an absent origin means rejection.
        const row = engine.statements.selectPendingResolution.get({
          session_id: sessionKey,
          local_seq: precondition.originLocalSeq,
        }) as { seq: number } | undefined;
        if (!row) {
          throw new PreconditionFailedError(
            "origin-committed",
            `origin commit not committed: localSeq ${precondition.originLocalSeq}`,
          );
        }
        break;
      }
      case "entity-absent": {
        const scopeKey = resolveScopeKey(precondition.scope, scopeContext);
        const existingSetOrDelete = engine.statements.selectSetDeleteConflict
          .get({
            branch,
            id: precondition.id,
            scope_key: scopeKey,
            after_seq: 0,
          }) as { seq: number } | undefined;
        if (existingSetOrDelete !== undefined) {
          throw new PreconditionFailedError(
            "receipt-exists",
            `entity-absent precondition target already exists: ${precondition.id}`,
          );
        }
        break;
      }
      case "entity-value-hash": {
        if (
          precondition.valueHash !== null &&
          typeof precondition.valueHash !== "string"
        ) {
          throw new ProtocolError(
            "malformed entity-value-hash precondition: valueHash must be a string or null",
          );
        }
        const state = readState(engine, {
          branch,
          id: precondition.id,
          scope: precondition.scope,
          principal: scopeContext.principal,
          sessionId: scopeContext.sessionId,
        });
        const currentHash = state?.document === null ||
            state?.document === undefined ||
            !Object.hasOwn(state.document, "value")
          ? null
          : commitPreconditionValueHash(state.document.value);
        if (currentHash !== precondition.valueHash) {
          throw new ConflictError(
            `entity-value-hash precondition target changed: ${precondition.id}`,
          );
        }
        break;
      }
      default:
        throw new ProtocolError(
          `unsupported commit precondition: ${
            String((precondition as { kind?: unknown }).kind)
          }`,
        );
    }
  }
};

const validateConfirmedReads = (
  engine: Engine,
  branch: BranchName,
  commit: ClientCommit,
  scopeContext: { principal?: string; sessionId: SessionId },
): void => {
  // A commit is evaluated under one connection principal/session context.
  // Every confirmed read in the commit resolves declared user/session scope
  // against that writer identity, even when the read points at another branch.
  // Cross-branch reads inherit this same principal context.
  const conflicts: ConfirmedReadConflict[] = [];
  const staleInstances = new Map<BranchName, Map<ScopeKey, Set<EntityId>>>();
  for (const read of commit.reads.confirmed) {
    const readBranch = read.branch ?? branch;
    requireBranch(engine, readBranch);
    const scopeKey = resolveScopeKey(read.scope, scopeContext);
    const scope = read.scope ?? DEFAULT_SCOPE;
    let staleScopes = staleInstances.get(readBranch);
    let staleIds = staleScopes?.get(scopeKey);
    // Further path scans cannot change a known-stale entity's recovery address.
    // Every read still validates its branch and scope before skipping the scan,
    // so invalid addresses take precedence over stale-read conflicts.
    if (staleIds?.has(read.id)) continue;
    const conflictSeq = findConflictSeq(
      engine,
      readBranch,
      read.id,
      scopeKey,
      read.seq,
      read.path,
      read.nonRecursive ?? false,
    );
    if (conflictSeq !== null) {
      if (staleScopes === undefined) {
        staleScopes = new Map();
        staleInstances.set(readBranch, staleScopes);
      }
      if (staleIds === undefined) {
        staleIds = new Set();
        staleScopes.set(scopeKey, staleIds);
      }
      staleIds.add(read.id);
      conflicts.push({
        of: read.id,
        scope,
        ...(readBranch === DEFAULT_BRANCH ? {} : { branch: readBranch }),
        seq: read.seq,
        conflictSeq,
      });
    }
  }
  if (conflicts.length > 0) {
    // Message-only clients recover by entity ID. Multiple scopes or branches
    // of one entity must not crowd other entities out of the bounded preview.
    // The array carries every stale instance and its diagnostic sequences.
    const messages = new Map<EntityId, string>();
    for (const { of, seq, conflictSeq } of conflicts) {
      if (!messages.has(of)) {
        messages.set(
          of,
          `stale confirmed read: ${of} at seq ${seq} conflicted with seq ${conflictSeq}`,
        );
      }
    }
    const preview = [...messages.values()].slice(0, 3);
    if (messages.size > preview.length) {
      const remaining = messages.size - preview.length;
      preview.push(`${remaining} more conflict${remaining === 1 ? "" : "s"}`);
    }
    throw new ConflictError(preview.join("; "), conflicts);
  }
};

/**
 * Validated `basisSeq` of a pending read — the CT-1910 true-basis shape — or
 * `undefined` for the legacy shape. In the SERVER's space-log seq space (an
 * accepted-commit `seq`, NOT the session's localSeq space); see
 * {@link PendingRead.basisSeq}. A basis ahead of the log claims knowledge
 * the server never produced. (A basis AT head is legal and yields an empty
 * scan — the same client-trusted claim a confirmed read at head makes.)
 */
const pendingReadBasisSeq = (
  engine: Engine,
  read: { id: string; basisSeq?: number },
): number | undefined => {
  const { basisSeq } = read;
  if (basisSeq === undefined) {
    return undefined;
  }
  if (!Number.isInteger(basisSeq) || basisSeq < 0) {
    throw new ProtocolError(
      `pending read on ${read.id} names a malformed basisSeq: ${basisSeq}`,
    );
  }
  if (basisSeq > serverSeq(engine)) {
    throw new ProtocolError(
      `pending read on ${read.id} claims a basisSeq ahead of the log: ${basisSeq}`,
    );
  }
  return basisSeq;
};

// Shared normalization/validation for a pending read's dependency set: a
// non-empty array (or scalar) of integer localSeqs. Malformed shapes are a
// protocol violation regardless of which validator (ordinary commit or
// scheduler observation) encounters them.
const pendingReadLayers = (
  read: { id: string; localSeq: number | number[] },
): number[] => {
  const layers = Array.isArray(read.localSeq) ? read.localSeq : [read.localSeq];
  if (layers.length === 0) {
    throw new ProtocolError(
      `pending read on ${read.id} names no localSeq`,
    );
  }
  for (const layer of layers) {
    if (!Number.isInteger(layer)) {
      throw new ProtocolError(
        `pending read on ${read.id} names a non-integer localSeq`,
      );
    }
  }
  return layers;
};

const resolvePendingReads = (
  engine: Engine,
  sessionKey: string,
  sessionId: SessionId,
  principal: string | undefined,
  branch: BranchName,
  commit: ClientCommit,
  // An identity commit resolves its dependencies but skips the staleness
  // scan: it changes nothing, so a stale basis decides nothing.
  options: { checkStaleness: boolean } = { checkStaleness: true },
): Array<{ localSeq: number; seq: number }> => {
  const resolutions = new Map<number, { localSeq: number; seq: number }>();

  for (const read of commit.reads.pending) {
    // An array localSeq names EVERY pending layer the read's view sat on:
    // each element must have resolved to an accepted commit, and staleness
    // is checked exactly once, from the basis §3.6.3 selects — the declared
    // `basisSeq` when present, else the resolution of the HIGHEST element —
    // the document's top-of-stack layer below the reader, which the array
    // MUST include (03-commit-model.md §3.5). A scalar is the single-layer
    // form.
    const layers = pendingReadLayers(read);
    let basis: { localSeq: number; seq: number } | undefined;
    for (const localSeq of layers) {
      let resolution = resolutions.get(localSeq);
      if (!resolution) {
        const row = engine.statements.selectPendingResolution.get({
          session_id: sessionKey,
          local_seq: localSeq,
        }) as { seq: number } | undefined;
        if (!row) {
          throw new ConflictError(
            `pending dependency not resolved: ${localSeq}`,
          );
        }
        resolution = { localSeq, seq: row.seq };
        resolutions.set(localSeq, resolution);
      }
      if (basis === undefined || localSeq > basis.localSeq) {
        basis = resolution;
      }
    }

    // CT-1910 repair: a reader that names its true confirmed basis is
    // scanned over the FULL interval (basisSeq, head], excluding only the
    // own-session layers its dependency array NAMES — the accepted layers
    // its materialized view included, per its own attestation. An own
    // write the array omits conflicts like a foreign one, so the scan
    // verifies that basisSeq plus the named layers fully account for the
    // doc's durable history at the read path. A legacy reader (no
    // basisSeq) keeps the max-dependency basis, so the over-advance
    // deviation persists for it alone
    // (docs/specs/memory-v2/09-invariants.md, INV-1).
    // The declared basis is validated whether or not the scan runs: an
    // identity commit's reads are exempt from staleness, not from the
    // protocol.
    const trueBasis = pendingReadBasisSeq(engine, read);
    if (!options.checkStaleness) continue;
    const conflictSeq = trueBasis !== undefined
      ? findConflictSeq(
        engine,
        branch,
        read.id,
        resolveScopeKey(read.scope, { principal, sessionId }),
        trueBasis,
        read.path,
        read.nonRecursive ?? false,
        { sessionKey, namedLocalSeqs: layers },
      )
      : findConflictSeq(
        engine,
        branch,
        read.id,
        resolveScopeKey(read.scope, { principal, sessionId }),
        basis!.seq,
        read.path,
        read.nonRecursive ?? false,
      );
    if (conflictSeq !== null) {
      throw new ConflictError(
        `stale pending read: ${read.id} via localSeq ${
          basis!.localSeq
        } conflicted with seq ${conflictSeq}`,
        [{
          of: read.id,
          scope: normalizeScope(read.scope),
          ...(branch === DEFAULT_BRANCH ? {} : { branch }),
          seq: trueBasis ?? basis!.seq,
          conflictSeq,
        }],
      );
    }
  }

  return [...resolutions.values()].sort((a, b) => a.localSeq - b.localSeq);
};

const findConflictSeq = (
  engine: Engine,
  branch: BranchName,
  id: EntityId,
  scopeKey: string,
  afterSeq: number,
  readPath: readonly string[],
  // When true, treat `readPath` as a SHALLOW (shape-only) dependency — conflict
  // only with writes at-or-above it (patchOverlapsNonRecursiveRead). Tier-1
  // (set/delete) stays path-blind even for a shallow read: a whole-doc
  // replace/delete changes the container the shape read observed, so it must
  // still conflict. Only Tier-2 (patch) granularity is refined.
  nonRecursive: boolean = false,
  // True-basis reads (CT-1910): skip writes produced by the own-session
  // layers the read NAMES — the accepted layers whose inclusion in the
  // reader's view the declared array attests. Any own write the array does
  // not name conflicts like a foreign write, whether it is a higher
  // localSeq accepted out of submission order or an omitted predecessor
  // whose write is durable; see the comment on the *_EXCLUDING_SESSION
  // statements.
  exclude?: { sessionKey: string; namedLocalSeqs: readonly number[] },
): number | null => {
  const setDeleteStatement = exclude === undefined
    ? engine.statements.selectSetDeleteConflict
    : engine.statements.selectSetDeleteConflictExcludingSession;
  const patchStatement = exclude === undefined
    ? engine.statements.selectPatchConflicts
    : engine.statements.selectPatchConflictsExcludingSession;
  const exclusionParams = exclude === undefined ? {} : {
    exclude_session: exclude.sessionKey,
    named_local_seqs: JSON.stringify(exclude.namedLocalSeqs),
  };
  const setOrDeleteConflict = setDeleteStatement.get({
    branch,
    id,
    scope_key: scopeKey,
    after_seq: afterSeq,
    ...exclusionParams,
  }) as { seq: number } | undefined;
  if (setOrDeleteConflict !== undefined) {
    return setOrDeleteConflict.seq;
  }

  for (
    const conflict of patchStatement.iter({
      branch,
      id,
      scope_key: scopeKey,
      after_seq: afterSeq,
      ...exclusionParams,
    }) as Iterable<{
      seq: number;
      data: string | null;
    }>
  ) {
    const patches = decodeStoredPatchList(conflict.data);
    const overlaps = nonRecursive
      ? patchOverlapsNonRecursiveRead(patches, readPath)
      : patchOverlapsRead(patches, readPath);
    if (overlaps) {
      return conflict.seq;
    }
  }

  return null;
};

// The COMMIT conflict matcher uses LEAF-ONLY touched paths (no add/remove/move
// parent-path injection) — the same discipline `touchedLeafPathsForPatch`
// applies to the scheduler reader-dirty index (CT-1623), here extended to the
// commit-conflict path. For a recursive read the injected parent is REDUNDANT
// (bidirectional `pathsOverlap` already matches a container reader against the
// leaf write, since the container read is a prefix of the leaf) and HARMFUL (the
// parent prefix-matches every disjoint SIBLING reader — e.g. a distinct-key
// writer's own-key/diff and link-resolution reads — manufacturing the
// write-contention over-conflict). Same-key writes still conflict (the leaf
// exactly matches an own-key read) and whole-container readers still conflict
// (their read prefixes the leaf). Keyset/shape readers are matched separately by
// the nonRecursive path, which keeps the parent injection.
export const patchOverlapsRead = (
  patches: readonly PatchOp[],
  readPath: readonly string[],
): boolean => {
  return patches.some((patch) =>
    touchedLeafPathsForPatch(patch).some((path) => pathsOverlap(path, readPath))
  );
};

// Overlap test for a SHALLOW (nonRecursive / shape-only) read. A shape read at
// `readPath` observed the container's key-set / existence but not its descendants'
// deep values, so it conflicts only with a write touching `readPath` itself or an
// ANCESTOR of it — `isPrefixPath(touched, readPath)`. Here we DO use the
// parent-injecting `touchedPathsForPatch`: a key add/remove injects the patch's
// parent path, which equals `readPath` for a direct child mutation, so a keyset
// reader still conflicts with key add/remove (the shape it observed changed). A
// disjoint deep-value `replace` strictly BELOW `readPath` touches no ancestor, so
// it no longer over-conflicts. Strict subset of `patchOverlapsRead` ⇒ never a
// false-negative. (Recursive reads use the leaf-only `patchOverlapsRead` above.)
export const patchOverlapsNonRecursiveRead = (
  patches: readonly PatchOp[],
  readPath: readonly string[],
): boolean => {
  return patches.some((patch) =>
    touchedPathsForPatch(patch).some((path) => isPrefixPath(path, readPath))
  );
};

const touchedPathsForPatch = (patch: PatchOp): string[][] => {
  const leaves = touchedPointerPaths(patch);
  // Ops that change the parent container's key-set — the structural ops
  // (add/remove/move) and a mergeable op that materialized a previously-absent
  // path (its `createsKey` flag) — also touch the parent, so a shape-only
  // reader of the parent must be invalidated. Ops that only change a value at an
  // already-present path touch only the leaf/array path, which such a reader
  // already prefixes.
  return patchOpChangesParentKeySet(patch)
    ? [...leaves, ...leaves.map((path) => parentPath(path))]
    : leaves;
};

// The EXACT changed leaf paths of a patch — without the ancestor/parent paths
// that `touchedPathsForPatch` adds for add/remove/move. Used by BOTH the
// scheduler reader-dirty index (`schedulerWriteAddressesForRevisions`) and the
// commit-conflict matcher (`patchOverlapsRead`).
//
// `touchedPathsForPatch` emits a patch's parent path so that whole-container
// reads are invalidated when a key is added/removed. For structural-overlap
// matching that parent path is both REDUNDANT and HARMFUL:
//   - Redundant: bidirectional prefix overlap already matches a reader of the
//     container (e.g. read `["value"]`) against the LEAF write
//     (e.g. `["value","plusOne"]`) — the container read is a prefix of the leaf —
//     so shape/whole-object readers are caught by the leaf alone.
//   - Harmful: the parent write (e.g. `["value"]`) ALSO prefix-matches every
//     disjoint SIBLING reader (`["value","doubled"]`, ...), whose value did not
//     change. The structural match has no way to tell the sibling is unchanged,
//     so it over-fires: spurious reload re-runs for the scheduler index
//     (CT-1623), and spurious commit conflicts for distinct-key writers (the
//     write-contention drops). Emitting only the leaf paths keeps every correct
//     match and drops the spurious sibling match. Keyset/shape (nonRecursive)
//     readers, which DO need to see key add/remove, are matched by a separate
//     path that retains `touchedPathsForPatch`'s parent injection.
const touchedLeafPathsForPatch = (patch: PatchOp): string[][] =>
  touchedPointerPaths(patch);

const selectCommitRevisions = (
  engine: Engine,
  commitSeq: number,
): AppliedRevision[] => {
  const rows = engine.statements.selectCommitRevisions.all({
    commit_seq: commitSeq,
  }) as RevisionRow[];
  return rows.map((row) => {
    const base = {
      id: row.id,
      scope: scopeOfScopeKey(row.scope_key),
      scopeKey: row.scope_key,
      branch: row.branch,
      seq: row.seq,
      opIndex: row.op_index,
      commitSeq: row.commit_seq,
      op: row.op,
    } satisfies Omit<AppliedRevision, "document" | "patches">;
    if (row.op === "set") {
      return {
        ...base,
        document: decodeStoredDocument(row.data),
      } satisfies AppliedRevision;
    }
    if (row.op === "patch") {
      return {
        ...base,
        patches: decodeStoredPatchList(row.data),
      } satisfies AppliedRevision;
    }
    return base as AppliedRevision;
  });
};

const materializeSnapshots = (
  engine: Engine,
  branch: BranchName,
  revisions: readonly AppliedRevision[],
): void => {
  if (engine.snapshotInterval <= 0) {
    return;
  }

  const seen = new Set<string>();
  for (const revision of revisions) {
    const revisionScopeKey = revision.scopeKey ?? DEFAULT_SCOPE_KEY;
    const key = revisionKey(branch, revision.id, revisionScopeKey);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    maybeMaterializeSnapshot(engine, branch, revision.id, revisionScopeKey);
  }
};

const rejectStoredSyncSchemaRef = (
  document: EntityDocument | undefined,
): void => {
  const ref = findSyncSchemaRef(document);
  if (ref !== undefined) {
    throw new ProtocolError(
      `memory v2 documents may not persist reserved wire schema reference: ${ref}`,
    );
  }
};

const validateStoredSyncSchemaRefs = (
  engine: Engine,
  branch: BranchName,
  revisions: readonly AppliedRevision[],
  serializedCommit: string,
): void => {
  // Every string a set document or patch operation carries appears verbatim
  // in the commit's serialization (already computed for the commit log), so
  // a commit whose serialization lacks both reserved prefixes can only put a
  // reference into a schema position via a JSON Patch move relocating a
  // string that already exists in the stored pre-state.
  const commitMayIntroduceRef = containsReservedSchemaRefSubstring(
    serializedCommit,
  );

  // Entities whose patches need post-state validation, keyed by revision key,
  // preserving this commit's revision order per entity.
  const statefulEntities = new Map<string, AppliedRevision[]>();

  for (const revision of revisions) {
    if (revision.op === "set" && commitMayIntroduceRef) {
      rejectStoredSyncSchemaRef(revision.document);
    }
    // Every revision here is set/patch/delete: sqlite operations never enter
    // the revisions list (see applyCommitTransaction).
    const key = revisionKey(
      branch,
      revision.id,
      revision.scopeKey ?? DEFAULT_SCOPE_KEY,
    );
    const isCandidatePatch = revision.op === "patch" &&
      (revision.patches?.some((patch) => patch.op === "move") === true ||
        (commitMayIntroduceRef &&
          containsSyncSchemaRefString(revision.patches)));
    const group = statefulEntities.get(key);
    if (group !== undefined) {
      // Once an entity is stateful, every later revision participates in the
      // replay so each intermediate stored state is validated.
      group.push(revision);
      continue;
    }
    if (isCandidatePatch) {
      // Earlier same-commit revisions of this entity are irrelevant history:
      // a set baseline is re-established by the replay's reconstruction.
      statefulEntities.set(key, [revision]);
    }
  }

  for (const group of statefulEntities.values()) {
    validateStatefulEntityRevisions(
      engine,
      branch,
      group,
      commitMayIntroduceRef,
    );
  }
};

/** Replays one entity's in-commit revisions, validating each stored state.
 *  Reconstructs the pre-state at most once per entity (and not at all when
 *  neither the commit nor any stored source row can contain a reserved
 *  reference), keeping validation linear in this commit's patch count. */
const validateStatefulEntityRevisions = (
  engine: Engine,
  branch: BranchName,
  entityRevisions: readonly AppliedRevision[],
  commitMayIntroduceRef: boolean,
): void => {
  const first = entityRevisions[0];
  const scopeKey = first.scopeKey ?? DEFAULT_SCOPE_KEY;
  if (
    !commitMayIntroduceRef &&
    !storedEntitySourcesMayContainRef(engine, {
      id: first.id,
      scopeKey,
      branch,
      seq: first.seq,
      opIndex: first.opIndex,
    })
  ) {
    // A move can only relocate an existing string, and every string in the
    // stored pre-state appears verbatim in some stored source row.
    return;
  }

  let document: EntityDocument | undefined;
  for (const revision of entityRevisions) {
    if (revision.op === "set") {
      document = revision.document;
      // Already validated by the set path when the commit can introduce a
      // reference; a clean commit's set document cannot contain one.
      continue;
    }
    if (revision.op !== "patch") {
      // A delete tombstones the entity: later in-commit patches start empty.
      document = emptyEntityDocument();
      continue;
    }
    document = document === undefined
      ? reconstructPatchedDocument(engine, {
        id: revision.id,
        scopeKey,
        branch,
        seq: revision.seq,
        opIndex: revision.opIndex,
      }).document
      : applyPatchToDocument(document, revision.patches ?? []);
    rejectStoredSyncSchemaRef(document);
  }
};

/** Substring probe over the serialized rows reconstruction would read — the
 *  latest set/snapshot base and the patch span — without decoding any of
 *  them. A negative answer proves the reconstructed pre-state cannot contain
 *  a reserved reference. */
const storedEntitySourcesMayContainRef = (
  engine: Engine,
  options: {
    id: EntityId;
    scopeKey: string;
    branch: BranchName;
    seq: number;
    opIndex: number;
  },
): boolean => {
  const { id, scopeKey, branch, seq, opIndex } = options;
  const baseRow = engine.statements.selectLatestBase.get({
    branch,
    id,
    scope_key: scopeKey,
    seq,
    op_index: opIndex,
  }) as ReadRow | undefined;
  const snapshotRow = engine.statements.selectLatestSnapshot.get({
    branch,
    id,
    scope_key: scopeKey,
    seq,
  }) as SnapshotRow | undefined;

  let baseSeq = 0;
  let baseOpIndex = -1;
  let baseMayContain = false;
  if (snapshotRow && (!baseRow || snapshotRow.seq >= baseRow.seq)) {
    baseSeq = snapshotRow.seq;
    baseOpIndex = Number.MAX_SAFE_INTEGER;
    baseMayContain = containsReservedSchemaRefSubstring(snapshotRow.value);
  } else if (baseRow) {
    baseSeq = baseRow.seq;
    baseOpIndex = baseRow.op_index;
    baseMayContain = baseRow.op === "set" && baseRow.data !== null &&
      containsReservedSchemaRefSubstring(baseRow.data);
  }
  if (baseMayContain) return true;

  const patches = engine.statements.selectPatches.all({
    branch,
    id,
    scope_key: scopeKey,
    base_seq: baseSeq,
    base_op_index: baseOpIndex,
    seq,
    op_index: opIndex,
  }) as Array<{ data: string }>;
  return patches.some((patch) =>
    containsReservedSchemaRefSubstring(patch.data)
  );
};

const maybeMaterializeSnapshot = (
  engine: Engine,
  branch: BranchName,
  id: EntityId,
  scopeKey: string,
): void => {
  const current = readStateForScopeKey(engine, { id, scopeKey, branch });
  if (current === null || current.document === null || current.op !== "patch") {
    return;
  }

  const baseSeq = latestMaterializationSeq(
    engine,
    branch,
    id,
    scopeKey,
    current.seq,
  );
  const patchCount = (
    engine.statements.selectPatchCount.get({
      branch,
      id,
      scope_key: scopeKey,
      after_seq: baseSeq,
      seq: current.seq,
    }) as { count: number }
  ).count;
  if (patchCount < engine.snapshotInterval) {
    return;
  }

  engine.statements.insertSnapshot.run({
    branch,
    id,
    scope_key: scopeKey,
    seq: current.seq,
    value: encodeMemoryBoundary(current.document),
  });
  compactSnapshots(engine, branch, id, scopeKey);
};

const compactSnapshots = (
  engine: Engine,
  branch: BranchName,
  id: EntityId,
  scopeKey: string,
): void => {
  if (engine.snapshotRetention <= 0) {
    return;
  }
  engine.statements.deleteOldSnapshots.run({
    branch,
    id,
    scope_key: scopeKey,
    retention: engine.snapshotRetention,
  });
};

const latestMaterializationSeq = (
  engine: Engine,
  branch: BranchName,
  id: EntityId,
  scopeKey: string,
  seq: number,
): number => {
  const baseRow = engine.statements.selectLatestBase.get({
    branch,
    id,
    scope_key: scopeKey,
    seq,
    op_index: Number.MAX_SAFE_INTEGER,
  }) as ReadRow | undefined;
  const snapshotRow = engine.statements.selectLatestSnapshot.get({
    branch,
    id,
    scope_key: scopeKey,
    seq,
  }) as SnapshotRow | undefined;
  return Math.max(baseRow?.seq ?? 0, snapshotRow?.seq ?? 0);
};

const reconstructPatchedDocument = (
  engine: Engine,
  options: {
    id: EntityId;
    scopeKey: string;
    branch: BranchName;
    seq: number;
    opIndex: number;
  },
): { document: EntityDocument; encodedBytes: number } => {
  const { id, scopeKey, branch, seq, opIndex } = options;
  const baseRow = engine.statements.selectLatestBase.get({
    branch,
    id,
    scope_key: scopeKey,
    seq,
    op_index: opIndex,
  }) as ReadRow | undefined;
  const snapshotRow = engine.statements.selectLatestSnapshot.get({
    branch,
    id,
    scope_key: scopeKey,
    seq,
  }) as SnapshotRow | undefined;

  let baseSeq = 0;
  let baseOpIndex = -1;
  if (snapshotRow && (!baseRow || snapshotRow.seq >= baseRow.seq)) {
    baseSeq = snapshotRow.seq;
    baseOpIndex = Number.MAX_SAFE_INTEGER;
  } else if (baseRow) {
    baseSeq = baseRow.seq;
    baseOpIndex = baseRow.op_index;
  }

  const patches = engine.statements.selectPatches.all({
    branch,
    id,
    scope_key: scopeKey,
    base_seq: baseSeq,
    base_op_index: baseOpIndex,
    seq,
    op_index: opIndex,
  }) as Array<{ data: string; seq: number; op_index: number }>;

  // A cached revision is an immutable prefix of this exact branch, scope,
  // and operation range. Replaying its suffix preserves frozen subtrees
  // instead of decoding and rebuilding the prefix at every commit.
  let document: EntityDocument | undefined;
  let replayFrom = 0;
  for (let index = patches.length - 1; index >= 0; index--) {
    const patch = patches[index];
    const cached = cachedDocumentForRevision(
      engine,
      documentCacheKey(
        branch,
        id,
        scopeKey,
        patch.seq,
        patch.op_index,
        "patch",
        patch.data.length,
      ),
    );
    if (cached?.document !== undefined && cached.document !== null) {
      engine.documentCacheStats.resumes++;
      document = cached.document;
      replayFrom = index + 1;
      break;
    }
  }
  if (document === undefined) {
    if (snapshotRow && snapshotRow.seq === baseSeq) {
      document = decodeStoredDocument(snapshotRow.value);
    } else if (baseRow?.op === "set") {
      document = cachedDocumentForRevision(
        engine,
        documentCacheKey(
          branch,
          id,
          scopeKey,
          baseRow.seq,
          baseRow.op_index,
          baseRow.op,
          baseRow.data?.length ?? -1,
        ),
      )?.document ?? decodeStoredDocument(baseRow.data);
    } else {
      document = emptyEntityDocument();
    }
  }

  for (const patch of patches.slice(replayFrom)) {
    engine.documentCacheStats.patchReplays++;
    document = applyPatchToDocument(
      document,
      decodeStoredPatchList(patch.data),
    );
  }

  // What the document cache weighs the result by: the result itself, as it
  // would be stored. No row the reconstruction read bounds it — additive
  // patches accumulate past any one of them — and a replay-cost sum
  // overstates it several times over (a Topics piece replayed from a base
  // and five near-whole patches decodes ~300 KB to retain ~55). Encoding
  // the result is exact and costs a fraction of the replay it follows.
  return {
    document,
    encodedBytes: storedByteLength(encodeMemoryBoundary(document)),
  };
};

/**
 * Helper for {@link readStateForScopeKey}, which finds the row holding
 * `options.id` on `options.branch` as of `options.seq`, or as of the branch's
 * head when no seq is given. A branch that holds no row inherits its parent's
 * as of the fork point.
 *
 * @throws When the branch does not exist, or when the seq lies outside the
 * branch's history.
 */
const readRowForBranch = (
  engine: Engine,
  options: {
    id: EntityId;
    scopeKey: string;
    branch: BranchName;
    seq?: number;
  },
): { row: ReadRow; branch: BranchName } | null => {
  const state = requireBranch(engine, options.branch);
  const seq = options.seq ?? state.headSeq;
  const minSeq = options.branch === DEFAULT_BRANCH ? 0 : state.createdSeq;
  if (seq < minSeq || seq > state.headSeq) {
    throw new Error(`seq ${seq} is out of range for branch ${options.branch}`);
  }

  const currentRow =
    (seq === state.headSeq
      ? engine.statements.selectCurrentLocal.get({
        branch: options.branch,
        id: options.id,
        scope_key: options.scopeKey,
      })
      : engine.statements.selectAtSeqLocal.get({
        branch: options.branch,
        id: options.id,
        scope_key: options.scopeKey,
        seq,
      })) as ReadRow | undefined;
  if (currentRow !== undefined) {
    return { row: currentRow, branch: options.branch };
  }

  if (state.parentBranch === null) {
    return null;
  }
  return readRowForBranch(engine, {
    id: options.id,
    scopeKey: options.scopeKey,
    branch: state.parentBranch,
    seq: Math.min(seq, state.forkSeq ?? 0),
  });
};

/**
 * Returns the `branch` row for `branch`, or `null` when there is none, from
 * {@link Engine.branchStates} when it holds the row. The state returned may
 * be the one the engine holds, which is why it is read-only.
 */
const getBranch = (
  engine: Engine,
  branch: BranchName,
): Readonly<BranchState> | null => {
  const known = engine.branchStates.get(branch);
  if (known !== undefined) {
    return known;
  }
  const row = engine.statements.selectBranch.get({
    branch,
  }) as BranchRow | undefined;
  if (row === undefined) {
    return null;
  }
  const state = toBranchState(row);
  // Inside a transaction the row may be one the transaction wrote, which a
  // rollback would take back.
  if (!engine.database.inTransaction) {
    engine.branchStates.set(branch, state);
  }
  return state;
};

/** Like {@link getBranch}, except that a branch with no row throws. */
const requireBranch = (
  engine: Engine,
  branch: BranchName,
): Readonly<BranchState> => {
  const state = getBranch(engine, branch);
  if (state === null) {
    throw new Error(`unknown branch: ${branch}`);
  }
  return state;
};

/**
 * Runs `statement`, which writes the `branch` table, then clears
 * {@link Engine.branchStates}, which may no longer match that table.
 */
const runBranchWrite = (
  engine: Engine,
  statement: PreparedStatement,
  ...params: Parameters<PreparedStatement["run"]>
): void => {
  statement.run(...params);
  engine.branchStates.clear();
};

const toBranchState = (row: BranchRow): BranchState => ({
  name: row.name,
  parentBranch: row.parent_branch,
  forkSeq: row.fork_seq,
  createdSeq: row.created_seq,
  headSeq: row.head_seq,
  status: row.status,
});

/**
 * The revision a cached document belongs to. Every part of the address is
 * needed: the same entity has a different document per branch and per scope,
 * and a different one again at each point in its history.
 *
 * The stored row's `op` and the length of its data join the address, and both
 * are a cheap discriminator rather than a check on content. Two rows of the
 * same op and size answer to the same key; and for a revision reconstructed
 * from patches the key says nothing at all about the base, snapshot and patch
 * rows the reconstruction read. Making it a real check would mean hashing
 * every row a read touches, which is the pass over the bytes this cache exists
 * to avoid.
 *
 * What the cache rests on is that the engine only ever appends revisions, so
 * what one decodes to does not change while the process runs. The shape in the
 * key covers the part of that which is cheap to cover — a row replaced by
 * something of a different size — and so keeps the engine's validate-on-decode
 * meaningful against it (`v2-engine-validation.test.ts`). A database that was
 * already wrong when it was opened is caught by the first decode either way.
 */
const documentCacheKey = (
  branch: BranchName,
  id: EntityId,
  scopeKey: string,
  seq: number,
  opIndex: number,
  op: string,
  dataLength: number,
): string =>
  `${branch}\u0000${id}\u0000${scopeKey}\u0000${seq}\u0000${opIndex}` +
  `\u0000${op}\u0000${dataLength}`;

/** Looks up a revision and records its use without publishing staged entries.
 * The counters stay with the callers: serving a read and finding where a
 * rebuild can resume are separate populations. */
const cachedDocumentForRevision = (
  engine: Engine,
  key: string,
): DocumentCacheEntry | undefined => {
  const staged = engine.stagedDocumentCache?.get(key);
  if (staged !== undefined) return staged;
  const cached = engine.documentCache.get(key);
  if (cached !== undefined) {
    engine.documentCache.delete(key);
    engine.documentCache.set(key, cached);
    engine.documentCacheCoordinator?.touched(engine);
  }
  return cached;
};

/**
 * Remember the document a revision decodes to.
 *
 * `applyCommit()` stages decoded revisions privately for reuse within its
 * transaction. Success publishes those entries; rollback discards them, so
 * a retry at the same sequence and operation index cannot reuse discarded
 * content. A read in an arbitrary external transaction can use durable entries
 * but declines to record newly decoded revisions.
 *
 * Eviction is least-recently-read, against a byte budget and an entry cap
 * (see DEFAULT_DOCUMENT_CACHE_BUDGET_BYTES): a working set that fits stays
 * resident across every walk that reads it, and what ages out is what was
 * not read again — superseded revisions foremost. An entry heavier than the
 * whole budget is served but not retained. The engine's coordinator, if it
 * has one, hears of each insertion and trims across engines then, the one
 * moment its total grows.
 */
const cacheDocumentForRevision = (
  engine: Engine,
  key: string,
  entry: DocumentCacheEntry,
): void => {
  if (engine.stagedDocumentCache !== undefined) {
    engine.stagedDocumentCache.set(key, entry);
    return;
  }
  if (engine.database.inTransaction) {
    return;
  }
  // A weight of at least one keeps the byte budget a real bound even for
  // rows with no data (a delete).
  const weight = Math.max(entry.weight, 1);
  if (weight > engine.documentCacheBudgetBytes) {
    return;
  }
  while (
    engine.documentCache.size > 0 &&
    (engine.documentCache.size >= engine.documentCacheMaxEntries ||
      engine.documentCacheBytes + weight > engine.documentCacheBudgetBytes)
  ) {
    dropOldestDocumentCacheEntry(engine);
  }
  engine.documentCache.set(key, { document: entry.document, weight });
  engine.documentCacheBytes += weight;
  engine.documentCacheCoordinator?.admitted(engine, weight);
};

const decodeStoredDocument = (data: string | null): EntityDocument =>
  decodeStoredDocumentPayload(decodeMemoryBoundary, data);

const decodeStoredPatchList = (data: string | null): PatchOp[] =>
  decodeStoredPatchListPayload(decodeMemoryBoundary, data);

const sameStoredOriginal = (
  stored: string,
  incoming: ClientCommit,
): boolean => {
  return stored === encodeMemoryBoundary(incoming);
};

const revisionKey = (
  branch: BranchName,
  id: EntityId,
  scopeKey: string,
): string => `${branch}\0${scopeKey}\0${id}`;

const LEGACY_EMPTY_INVOCATION_REF =
  "memory-v2:legacy-empty-invocation" as Reference;
const LEGACY_EMPTY_AUTHORIZATION_REF =
  "memory-v2:legacy-empty-authorization" as Reference;
const LEGACY_EMPTY_INVOCATION: InvocationRecord = {
  iss: "did:key:memory-v2-legacy-placeholder",
  aud: null,
  cmd: "/memory/transact/legacy-placeholder",
  sub: "did:key:memory-v2-legacy-placeholder",
};
const LEGACY_EMPTY_AUTHORIZATION: AuthorizationRecord = {};

const commitMetadataRefsRequired = (database: Database): boolean => {
  const rows = database.prepare(`PRAGMA table_info("commit")`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  const byName = new Map(rows.map((row) => [row.name, row.notnull] as const));
  return byName.get("invocation_ref") === 1 ||
    byName.get("authorization_ref") === 1;
};

const toDatabaseAddress = (url: URL): URL | string => {
  return url.protocol === "file:" ? url : ":memory:";
};
