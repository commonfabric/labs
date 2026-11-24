/**
 * The currency index (docs/specs/server-side-execution/serving-loop.md §3b):
 * which stored outputs a serving loop vouched for, and the marks that say a
 * piece's stored outputs may no longer be what it would compute.
 *
 * A piece is recorded in slices, one per scope key its computations ran at:
 * `space` for what every viewer shares, and a user's or a session's key for
 * what was computed for that viewer alone. A serving loop stores a record at
 * a quiescent point: for each slice, the document instances its computations
 * read and the instances they vouch for, and for the piece, what it writes.
 * A change to an instance a slice read or vouches for marks that slice, and
 * a marked slice marks each slice of another piece that reads an instance it
 * writes, so a mark reaches a piece through documents no session demands.
 * Storing a new record of a slice is the only thing that clears its mark,
 * and a record replaces the slices it names and leaves a viewer's others as
 * they are.
 *
 * A slice can read an instance of another space's store. That store is the
 * instance's source, and keeps the list of the spaces that read it. The
 * reading space registers the read, pulls from the source what it reports
 * of the instances registered, and holds what it last said: the instance's
 * head there, and whether what it holds is stale upstream. Each call that
 * changes the index leaves what the store reports of its registered
 * instances current, so the memory server can tell a reading space that
 * one of them moved without that space asking.
 *
 * Rows are identifiers and sequence numbers, overwritten in place, with the
 * slice leading each key: reading one viewer's slices reads no other
 * viewer's rows. Each function here that writes opens its own transaction;
 * none of them runs at admission.
 */

import {
  fabricAwareEqual,
  isFabricPlainObject,
} from "@commonfabric/data-model";
import { isLinkRef, linkRefPayload } from "@commonfabric/data-model/cell-rep";
import {
  decodeTrustedMemoryBoundary,
  DEFAULT_BRANCH,
  resolveScopeKey,
  type ScopeKey,
  scopeOfScopeKey,
} from "../v2.ts";
import { ANY_INSTANCE, sliceChain, SPACE_SLICE } from "./currency-keys.ts";
import { type Engine, read, serverSeq } from "./engine.ts";

/**
 * Whether two documents read from the store hold the same value. A stored
 * value can hold a link, a byte sequence or another special object, which
 * keeps its state out of its properties, so the comparison is the one that
 * decides those by content. Two documents it cannot decide are not the
 * same: a pair of maps or of sets, which it does not hash yet.
 */
const sameDocument = (a: unknown, b: unknown): boolean => {
  try {
    return fabricAwareEqual(a, b);
  } catch {
    return false;
  }
};

/** What the id of a document some computation derives begins with. */
const COMPUTED_ID_PREFIX = "computed:";

/**
 * The seq a row of `currency_decide` stands at for a slot that holds a
 * write later than its slice's: below the head of every instance, one with
 * no revision included.
 */
const SUPERSEDED_SEQ = -1;

/**
 * The scope key of the run that made the write at `opIndex` of a serving
 * loop's derivation, read off the attribution the commit stores with each
 * write (protocol.md §1): `space` for a run that acted as nobody, a user's
 * key for one that acted as the user, and a session's for one that acted as
 * the pair. `undefined` where `annotations`, the commit's stored column,
 * attributes that write to no run.
 *
 * A run acts as the narrowest scope it read, and is filed under the scope
 * its node has read for that viewer in any run, so the key is that of the
 * run's slice only where the two agree.
 */
const runKeyOf = (
  annotations: string | null,
  opIndex: number,
): string | undefined => {
  const stored = annotations === null
    ? undefined
    : decodeTrustedMemoryBoundary(annotations);
  const found = Array.isArray(stored)
    ? stored.find((entry) => isFabricPlainObject(entry) && entry.op === opIndex)
    : undefined;
  if (!isFabricPlainObject(found)) return undefined;
  const { actingUser: principal, actingSession: sessionId } = found;
  if (typeof principal !== "string" || principal === "") return SPACE_SLICE;
  return typeof sessionId === "string" && sessionId !== ""
    ? resolveScopeKey("session", { principal, sessionId })
    : resolveScopeKey("user", { principal });
};

export { ANY_INSTANCE };

/**
 * What the index holds about a slice's stored outputs: `0` clean, `1` one of
 * its inputs is stale, `2` one of its own rows is behind or the slice was
 * not vouched for.
 *
 * An input is stale where it is a computed instance whose recorded writer is
 * marked or no longer vouches for it, where it is a derived document no
 * computation may have produced yet (`unproduced()`), and where it is an
 * instance of another space that its source reported stale upstream. A row
 * is behind where its document's head is above it, in this store or, for a
 * read in another space, in what its source last reported.
 */
export type CurrencyMark = 0 | 1 | 2;

/** One document instance a slice read. */
export type CurrencyRead = {
  /** The space the document is in. */
  space: string;

  /** The document's id. */
  id: string;

  /** The scope key of the instance read, or `ANY_INSTANCE`. */
  scopeKey: string;

  /** Whether some computation writes the document. */
  derived: boolean;

  /**
   * For a read in another space, the seq of that space the run read the
   * instance at. A read in another space that names none is one the slice
   * cannot be vouched for with.
   */
  seq?: number;
};

/** What a source space reports of one instance another space registered. */
export type CurrencyExport = CurrencyInstance & {
  /** The instance's head seq in the source, `0` for an absent one. */
  head: number;

  /**
   * Whether what the source holds is stale upstream: a recorded piece there
   * computes the instance, and a slice that decides it is marked or none
   * vouches for it, or it is a derived document no recorded piece writes
   * that no computation may have produced yet (`unproduced()`).
   */
  stale: boolean;
};

/** One document instance, as a demand row names it. */
export type CurrencyInstance = {
  /** The document's id. */
  id: string;

  /** The instance's scope key. */
  scopeKey: string;
};

/** What a serving loop recorded about one slice of a piece. */
export type CurrencySliceRecord = {
  /** The slice's scope key. */
  key: string;

  /**
   * Whether the loop vouches for the slice. One it does not is stored marked
   * `2`, whatever its rows say.
   */
  vouched: boolean;

  /** The document instances the slice's live computations read. */
  reads: readonly CurrencyRead[];

  /**
   * The ids of the documents whose instance at the slice's key a live, clean
   * computation of the piece wrote.
   */
  vouches: readonly string[];

  /**
   * The instances at another key that a live, clean computation of the
   * slice wrote, as a run made for one viewer leaves a redirect at the
   * user's and the space's key. What such a slot holds was decided by the
   * slice's reads, so the slice answers for it. Absent for a slice that
   * wrote none.
   */
  decides?: readonly CurrencyInstance[];

  /**
   * The instances at another key that a run of the slice wrote and that
   * something has changed since, as another viewer's run does that writes
   * the slot differently. Such a slot holds that later write, so the slice
   * answers for it no longer: its row is stored behind the slot's head,
   * where a viewer of the slice who demands the slot is refused. Absent
   * for a slice with none.
   */
  superseded?: readonly CurrencyInstance[];

  /**
   * The time, in milliseconds since the epoch, from which the slice is no
   * longer current whatever its rows say: the next tick of a clock one of
   * its runs read. Absent for a slice only a commit can make stale.
   */
  expiresAt?: number;
};

/** What a serving loop recorded about one piece at a quiescent point. */
export type CurrencyRecord = {
  /** The raw id of the piece's result document. */
  piece: string;

  /** The pieces that enclose this one. */
  under: readonly string[];

  /**
   * Whether the loop vouches for the piece at all. Every slice of a record
   * that does not is stored marked `2`.
   */
  vouched: boolean;

  /**
   * The ids in the declared write surface of every computation registered
   * under the piece, whether or not it has run.
   */
  writes: readonly string[];

  /** The ids of the cells the piece owns and owes a default. */
  owned: readonly string[];

  /**
   * Whether the piece records a source origin (serving-loop.md §3e), which
   * a serving loop follows before it leaves a demanded root that rests on
   * the piece unstarted.
   */
  followsOrigin?: boolean;

  /**
   * The slices a live computation of the piece ran at when the record was
   * taken. A viewer's slice the piece holds and the record does not name is
   * left as it is. A record that names no `space` slice leaves the one the
   * piece holds as it is where that slice is clean and of the batch's epoch
   * and the record is vouched for, and has one that read nothing stored
   * otherwise.
   */
  slices: readonly CurrencySliceRecord[];
};

/** The records of one quiescent point. */
export type CurrencyBatch = {
  /** The space the engine holds, which tells a foreign read apart. */
  space: string;

  /** The highest input seq the quiescent point covered. */
  asOf: number;

  /**
   * The seqs above `asOf` whose commits the recording loop made itself, and
   * so had seen at the quiescent point.
   */
  seen: readonly number[];

  /** The epoch the recording loop records under. */
  epoch: string;

  /** The records, one per piece. */
  records: readonly CurrencyRecord[];

  /**
   * Pieces of the same quiescent point that earlier batches stored. Pieces
   * that read each other's writes are clean only together, so the last batch
   * of a point names the others and they are settled as one.
   */
  settle?: readonly string[];
};

/** A slice an advance of the cursor marked. */
export type CurrencyMarked = {
  /** The piece. */
  piece: string;

  /** The slice of it that was marked. */
  slice: string;

  /**
   * A seq at or below the first change that marks the slice: an input at
   * this seq or above is one its stored outputs do not reflect.
   */
  seq: number;

  /** The pieces that enclose the piece. */
  under: string[];

  /**
   * Present where the slice is left marked `1`: none of its own rows is
   * behind, and an input of it is stale.
   */
  upstream?: true;
};

/** What storing a batch found. */
export type CurrencyStored = {
  /** What the advance that precedes the store marked. */
  marked: CurrencyMarked[];

  /**
   * The pieces with a slice that had been clean since its last record, then
   * wrote an instance it answered for again, to a value other than the one
   * it held, with no input of its having changed: what it held was not what
   * it computes. An instance the slice vouched for at its own key counts
   * whichever derivation wrote it. One it decided at another key counts
   * where every revision since is attributed to a run at the slice's key
   * and the batch names the instance as one the slice decides, so a slot
   * another slice's run wrote in between is not counted.
   */
  falseClean: string[];

  /**
   * The pieces of the batch with a slice stored `1`, every row of which is
   * current.
   */
  blocked: string[];

  /**
   * The pieces outside the batch with a marked slice that keeps a slice of
   * `blocked` at `1`. A loop that runs one records it together with what it
   * blocks, since pieces that read each other's writes settle only in one
   * batch.
   */
  blockedBy: string[];

  /**
   * The pieces of the batch with a vouched-for slice stored marked `2` for
   * no reason but a commit above `asOf` that the batch does not name as
   * seen. A record of one taken at a quiescent point that covers that commit
   * is not marked for it.
   */
  behind: string[];

  /**
   * The other spaces a slice of the batch read before this record and reads
   * no longer. Each may hold a registration nothing here reads behind any
   * more, which a pull from it drops.
   */
  unread: string[];
};

/** One slice's row, for a caller that inspects the index. */
export type CurrencySliceRow = {
  /** The slice's mark. */
  mark: CurrencyMark;

  /** The epoch it was recorded under. */
  epoch: string;
};

/** One slice of one piece. */
type SliceRef = { piece: string; slice: string };

/** A key that names `ref` in a set or a map. */
const refKey = (ref: SliceRef): string => `${ref.slice}\0${ref.piece}`;

/**
 * The parameters that select the scope keys at `key` or narrower beneath it:
 * every key for the space, a user's key and its sessions' for a user, and
 * the key alone for a session.
 */
const atOrBeneath = (
  key: string,
): { all: number; key: string; lo: string; hi: string } => {
  if (key === SPACE_SLICE) return { all: 1, key, lo: "", hi: "" };
  if (scopeOfScopeKey(key) !== "user") return { all: 0, key, lo: "", hi: "" };
  // A user's sessions are keyed `session:<principal>:<session>`, and `;` is
  // the character after `:`.
  const principal = key.slice("user:".length);
  return {
    all: 0,
    key,
    lo: `session:${principal}:`,
    hi: `session:${principal};`,
  };
};

type Statements = ReturnType<typeof statementsFor>;

/** The prepared statements over the index, for `engine`. */
const statementsFor = (engine: Engine) => ({
  selectSlice: engine.prepare(`
SELECT mark, was_clean, epoch, unvouched FROM currency_slice
WHERE branch = :branch AND slice = :slice AND piece = :piece
`),
  selectSlicesOfPiece: engine.prepare(`
SELECT slice, mark FROM currency_slice
WHERE branch = :branch AND piece = :piece
`),
  countSlices: engine.prepare(`
SELECT COUNT(*) AS count FROM currency_slice WHERE branch = :branch
`),
  upsertSlice: engine.prepare(`
INSERT INTO currency_slice (
  branch, slice, piece, mark, was_clean, epoch, unvouched
)
VALUES (:branch, :slice, :piece, :mark, 0, :epoch, :unvouched)
ON CONFLICT (branch, slice, piece)
DO UPDATE SET mark = excluded.mark, was_clean = 0, epoch = excluded.epoch,
  unvouched = excluded.unvouched
`),
  setWasClean: engine.prepare(`
UPDATE currency_slice SET was_clean = 1
WHERE branch = :branch AND slice = :slice AND piece = :piece
`),
  setMark: engine.prepare(`
UPDATE currency_slice SET mark = :mark
WHERE branch = :branch AND slice = :slice AND piece = :piece
`),
  selectCommitClass: engine.prepare(`
SELECT class FROM "commit" WHERE seq = :seq
`),
  selectInstanceHead: engine.prepare(`
SELECT seq FROM head
WHERE branch = :branch AND id = :id AND scope_key = :scope_key
`),
  selectHighestHead: engine.prepare(`
SELECT MAX(seq) AS seq FROM head WHERE branch = :branch AND id = :id
`),
  selectHeadOp: engine.prepare(`
SELECT op FROM head
WHERE branch = :branch AND id = :id AND scope_key = :scope_key
`),
  deleteUnder: engine.prepare(`
DELETE FROM currency_under WHERE branch = :branch AND piece = :piece
`),
  // The pieces a root encloses, read through the index that leads with the
  // root: the table's own key leads with the piece enclosed.
  selectBeneath: engine.prepare(`
SELECT piece FROM currency_under WHERE branch = :branch AND root = :root
`),
  insertOrigin: engine.prepare(`
INSERT OR IGNORE INTO currency_origin (branch, piece)
VALUES (:branch, :piece)
`),
  deleteOrigin: engine.prepare(`
DELETE FROM currency_origin WHERE branch = :branch AND piece = :piece
`),
  selectOrigin: engine.prepare(`
SELECT 1 AS found FROM currency_origin
WHERE branch = :branch AND piece = :piece
`),
  insertUnder: engine.prepare(`
INSERT OR IGNORE INTO currency_under (branch, piece, root)
VALUES (:branch, :piece, :root)
`),
  selectUnder: engine.prepare(`
SELECT root FROM currency_under WHERE branch = :branch AND piece = :piece
`),
  deleteReads: engine.prepare(`
DELETE FROM currency_read
WHERE branch = :branch AND slice = :slice AND piece = :piece
`),
  insertRead: engine.prepare(`
INSERT INTO currency_read
  (branch, slice, piece, entity_space, entity, entity_scope_key, derived, seq)
VALUES
  (:branch, :slice, :piece, :entity_space, :entity, :entity_scope_key,
   :derived, :seq)
ON CONFLICT (branch, slice, piece, entity_space, entity, entity_scope_key)
DO UPDATE SET derived = MAX(derived, excluded.derived), seq = excluded.seq
`),
  selectReads: engine.prepare(`
SELECT entity_space, entity, entity_scope_key, derived, seq FROM currency_read
WHERE branch = :branch AND slice = :slice AND piece = :piece
`),
  deleteWrites: engine.prepare(`
DELETE FROM currency_write WHERE branch = :branch AND piece = :piece
`),
  insertWrite: engine.prepare(`
INSERT INTO currency_write (branch, piece, id, owned)
VALUES (:branch, :piece, :id, :owned)
ON CONFLICT (branch, piece, id)
DO UPDATE SET owned = MIN(owned, excluded.owned)
`),
  selectWrites: engine.prepare(`
SELECT id FROM currency_write
WHERE branch = :branch AND piece = :piece AND owned = 0
`),
  selectWriters: engine.prepare(`
SELECT piece FROM currency_write
WHERE branch = :branch AND id = :id AND owned = 0
`),
  selectOwners: engine.prepare(`
SELECT piece, owned FROM currency_write
WHERE branch = :branch AND id = :id
`),
  releaseVouches: engine.prepare(`
UPDATE currency_vouch SET held = 0
WHERE branch = :branch AND slice = :slice AND piece = :piece
`),
  upsertVouch: engine.prepare(`
INSERT INTO currency_vouch (branch, slice, piece, id, seq, held)
VALUES (:branch, :slice, :piece, :id, :seq, 1)
ON CONFLICT (branch, slice, piece, id)
DO UPDATE SET seq = excluded.seq, held = 1
`),
  selectVouch: engine.prepare(`
SELECT seq FROM currency_vouch
WHERE branch = :branch AND slice = :slice AND piece = :piece AND id = :id
  AND held = 1
`),
  selectVouches: engine.prepare(`
SELECT id, seq, held FROM currency_vouch
WHERE branch = :branch AND slice = :slice AND piece = :piece
`),
  deleteDecides: engine.prepare(`
DELETE FROM currency_decide
WHERE branch = :branch AND slice = :slice AND piece = :piece
`),
  insertDecide: engine.prepare(`
INSERT OR REPLACE INTO currency_decide (
  branch, slice, piece, id, instance_key, seq
)
VALUES (:branch, :slice, :piece, :id, :instance_key, :seq)
`),
  // The slots one slice answers for whose head stands above its row. A row
  // stored behind every head answers for no slot, and is left out.
  selectDecidesBehind: engine.prepare(`
SELECT d.id AS id, d.instance_key AS instance_key, d.seq AS seq
FROM currency_decide d
JOIN head h
  ON h.branch = d.branch AND h.id = d.id AND h.scope_key = d.instance_key
WHERE d.branch = :branch AND d.slice = :slice AND d.piece = :piece
  AND d.seq > ${SUPERSEDED_SEQ} AND h.seq > d.seq
`),
  // The writes one commit made to one instance, each with what the commit
  // stores of the runs that made its writes.
  selectRevisionWriters: engine.prepare(`
SELECT r.op_index AS op_index, c.annotations AS annotations
FROM revision r
JOIN "commit" c ON c.seq = r.commit_seq
WHERE r.branch = :branch AND r.id = :id AND r.scope_key = :scope_key
  AND r.seq = :seq
`),
  // The rows for one slot, of whichever slices' runs wrote it.
  selectDeciders: engine.prepare(`
SELECT slice, piece, seq FROM currency_decide
  INDEXED BY idx_currency_decide_instance
WHERE branch = :branch AND instance_key = :scope_key AND id = :id
`),

  selectCursor: engine.prepare(`
SELECT seq FROM currency_cursor WHERE branch = :branch
`),
  upsertCursor: engine.prepare(`
INSERT INTO currency_cursor (branch, seq) VALUES (:branch, :seq)
ON CONFLICT (branch) DO UPDATE SET seq = excluded.seq
`),
  selectChangedSince: engine.prepare(`
SELECT id, scope_key, MIN(seq) AS lowest, MAX(seq) AS highest FROM revision
WHERE branch = :branch AND seq > :seq
GROUP BY id, scope_key
`),
  selectRevisionSeqsAbove: engine.prepare(`
SELECT DISTINCT seq FROM revision
WHERE branch = :branch AND id = :id AND scope_key = :scope_key AND seq > :seq
`),
  selectAnyRevisionSeqsAbove: engine.prepare(`
SELECT DISTINCT seq FROM revision
WHERE branch = :branch AND id = :id AND seq > :seq
`),
  selectReadersBehind: engine.prepare(`
SELECT slice, piece, seq FROM currency_read
WHERE branch = :branch AND entity_space = :space AND entity = :id
  AND (entity_scope_key = :scope_key OR entity_scope_key = '${ANY_INSTANCE}')
  AND seq < :seq
`),
  selectVouchesBehind: engine.prepare(`
SELECT piece, seq FROM currency_vouch INDEXED BY idx_currency_vouch_id
WHERE branch = :branch AND slice = :scope_key AND id = :id AND seq < :seq
  AND held = 1
`),
  // The readers of every slot one slice decides, where the slice's row
  // stands at the slot's head. One statement for the slice, starting from
  // its decide rows: a slice decides two slots for each document a session's
  // run writes, so a statement for each slot is thousands for one walk.
  selectReadersOfDecided: engine.prepare(`
SELECT DISTINCT r.slice AS slice, r.piece AS piece, s.mark AS mark,
  d.instance_key AS instance_key
FROM currency_decide d
LEFT JOIN head h
  ON h.branch = d.branch AND h.id = d.id AND h.scope_key = d.instance_key
CROSS JOIN currency_read r INDEXED BY idx_currency_read_entity
  ON r.branch = d.branch AND r.entity_space = :space AND r.entity = d.id
CROSS JOIN currency_slice s
  ON s.branch = r.branch AND s.slice = r.slice AND s.piece = r.piece
WHERE d.branch = :branch AND d.slice = :slice AND d.piece = :piece
  AND d.seq >= COALESCE(h.seq, 0)
  AND (r.entity_scope_key = d.instance_key
    OR r.entity_scope_key = '${ANY_INSTANCE}')
  AND NOT (r.piece = :piece AND r.slice = :slice)
`),
  selectReadersOfInstance: engine.prepare(`
SELECT slice, piece FROM currency_read
WHERE branch = :branch AND entity_space = :space AND entity = :id
  AND (entity_scope_key = :scope_key OR entity_scope_key = '${ANY_INSTANCE}')
`),
  selectDerivationOfInstance: engine.prepare(`
SELECT 1 AS found FROM revision r
JOIN "commit" c ON c.seq = r.commit_seq
WHERE r.branch = :branch AND r.id = :id AND r.scope_key = :scope_key
  AND c.class = 'derived'
LIMIT 1
`),
  selectRevisionAt: engine.prepare(`
SELECT 1 AS found FROM revision
WHERE branch = :branch AND id = :id AND scope_key = :scope_key AND seq = :seq
LIMIT 1
`),
  // The join names its order and its index: it starts from one piece's write
  // rows, and a plan that starts from the read rows reads every row of the
  // branch.
  selectReadersOfSlice: engine.prepare(`
SELECT DISTINCT r.slice AS slice, r.piece AS piece, s.mark AS mark
FROM currency_write w
CROSS JOIN currency_read r INDEXED BY idx_currency_read_entity
  ON r.branch = w.branch AND r.entity_space = :space AND r.entity = w.id
CROSS JOIN currency_slice s
  ON s.branch = r.branch AND s.slice = r.slice AND s.piece = r.piece
WHERE w.branch = :branch AND w.piece = :piece AND w.owned = 0
  AND NOT (r.piece = :piece AND r.slice = :slice)
  AND (:all = 1 OR r.entity_scope_key = :key
    OR r.entity_scope_key = '${ANY_INSTANCE}'
    OR (r.entity_scope_key >= :lo AND r.entity_scope_key < :hi))
`),
  selectLocalReads: engine.prepare(`
SELECT entity, entity_scope_key, derived FROM currency_read
WHERE branch = :branch AND slice = :slice AND piece = :piece
  AND entity_space = :space
`),
  selectLocalRead: engine.prepare(`
SELECT derived FROM currency_read
WHERE branch = :branch AND slice = :slice AND piece = :piece
  AND entity_space = :space AND entity = :entity
  AND entity_scope_key = :entity_scope_key
`),
  selectReadAsDerived: engine.prepare(`
SELECT 1 AS found FROM currency_read INDEXED BY idx_currency_read_entity
WHERE branch = :branch AND entity_space = :space AND entity = :entity
  AND derived = 1
LIMIT 1
`),
  selectForeignReads: engine.prepare(`
SELECT entity_space, entity, entity_scope_key FROM currency_read
WHERE branch = :branch AND slice = :slice AND piece = :piece
  AND entity_space != :space
`),
  selectReadersOfImport: engine.prepare(`
SELECT slice, piece, seq FROM currency_read
WHERE branch = :branch AND entity_space = :source AND entity = :id
  AND entity_scope_key = :scope_key
`),
  deleteSliceSources: engine.prepare(`
DELETE FROM currency_slice_source
WHERE branch = :branch AND slice = :slice AND piece = :piece
`),
  insertSliceSource: engine.prepare(`
INSERT OR IGNORE INTO currency_slice_source (branch, slice, piece, source)
VALUES (:branch, :slice, :piece, :source)
`),
  selectSourcesOfSlice: engine.prepare(`
SELECT DISTINCT source FROM currency_slice_source
WHERE branch = :branch AND slice = :slice
`),
  selectSourcesOfPieceSlice: engine.prepare(`
SELECT source FROM currency_slice_source
WHERE branch = :branch AND slice = :slice AND piece = :piece
`),
  selectImport: engine.prepare(`
SELECT head, stale FROM currency_import
WHERE branch = :branch AND source = :source AND id = :id
  AND scope_key = :scope_key
`),
  upsertImport: engine.prepare(`
INSERT INTO currency_import (branch, source, id, scope_key, head, stale)
VALUES (:branch, :source, :id, :scope_key, :head, :stale)
ON CONFLICT (branch, source, id, scope_key)
DO UPDATE SET head = excluded.head, stale = excluded.stale
`),
  deleteImport: engine.prepare(`
DELETE FROM currency_import
WHERE branch = :branch AND source = :source AND id = :id
  AND scope_key = :scope_key
`),
  selectImportsOfSource: engine.prepare(`
SELECT id, scope_key FROM currency_import
WHERE branch = :branch AND source = :source
`),
  selectSourcePosition: engine.prepare(`
SELECT position FROM currency_source
WHERE branch = :branch AND source = :source
`),
  upsertSourcePosition: engine.prepare(`
INSERT INTO currency_source (branch, source, position)
VALUES (:branch, :source, :position)
ON CONFLICT (branch, source) DO UPDATE SET position = excluded.position
`),
  deleteSourcePosition: engine.prepare(`
DELETE FROM currency_source WHERE branch = :branch AND source = :source
`),
  insertReader: engine.prepare(`
INSERT OR IGNORE INTO currency_reader (branch, reader, id, scope_key)
VALUES (:branch, :reader, :id, :scope_key)
`),
  deleteReader: engine.prepare(`
DELETE FROM currency_reader
WHERE branch = :branch AND reader = :reader AND id = :id
  AND scope_key = :scope_key
`),
  selectExport: engine.prepare(`
SELECT head, stale FROM currency_export
WHERE branch = :branch AND id = :id AND scope_key = :scope_key
`),
  upsertExport: engine.prepare(`
INSERT INTO currency_export (branch, id, scope_key, head, stale, position)
VALUES (:branch, :id, :scope_key, :head, :stale, :position)
ON CONFLICT (branch, id, scope_key)
DO UPDATE SET head = excluded.head, stale = excluded.stale,
  position = excluded.position
`),
  selectHighestPosition: engine.prepare(`
SELECT MAX(position) AS position FROM currency_export WHERE branch = :branch
`),
  deleteExpiry: engine.prepare(`
DELETE FROM currency_expiry
WHERE branch = :branch AND slice = :slice AND piece = :piece
`),
  insertExpiry: engine.prepare(`
INSERT INTO currency_expiry (branch, slice, piece, expires_at)
VALUES (:branch, :slice, :piece, :expires_at)
`),
  selectExpired: engine.prepare(`
SELECT slice, piece FROM currency_expiry
WHERE branch = :branch AND expires_at <= :now
`),
  selectNextExpiry: engine.prepare(`
SELECT MIN(expires_at) AS expires_at FROM currency_expiry
WHERE branch = :branch
`),
  selectAnyExport: engine.prepare(`
SELECT 1 AS found FROM currency_export WHERE branch = :branch LIMIT 1
`),
  selectExportsOfId: engine.prepare(`
SELECT scope_key FROM currency_export WHERE branch = :branch AND id = :id
`),
  selectExportedIds: engine.prepare(`
SELECT DISTINCT id FROM currency_export WHERE branch = :branch
`),
  selectReadersMovedSince: engine.prepare(`
SELECT r.reader AS reader, MAX(e.position) AS position
FROM currency_export e INDEXED BY idx_currency_export_position
JOIN currency_reader r INDEXED BY idx_currency_reader_instance
  ON r.branch = e.branch AND r.id = e.id AND r.scope_key = e.scope_key
WHERE e.branch = :branch AND e.position > :since
GROUP BY r.reader
`),
  selectSources: engine.prepare(`
SELECT DISTINCT source FROM currency_slice_source WHERE branch = :branch
`),
  selectExportsSince: engine.prepare(`
SELECT e.id AS id, e.scope_key AS scope_key, e.head AS head, e.stale AS stale
FROM currency_reader r
JOIN currency_export e
  ON e.branch = r.branch AND e.id = r.id AND e.scope_key = r.scope_key
WHERE r.branch = :branch AND r.reader = :reader AND e.position > :since
`),
});

/** What the index needs to know to work on one engine's space. */
type Context = {
  engine: Engine;
  branch: string;
  space: string;
  statements: Statements;

  /** The time the call was made at, in milliseconds since the epoch. */
  now: number;

  /**
   * What a change to the index touched, where the store tells other spaces
   * of any instance: the documents a commit wrote, and the pieces a slice
   * of which changed its mark or its rows. `refreshTouched()` brings what
   * the store tells its readers of them up to date.
   */
  touched?: { ids: Set<string>; pieces: Set<string> };
};

/** What the index holds of one recorded slice. */
type SliceRow = {
  mark: CurrencyMark;
  was_clean: number;
  epoch: string;

  /** `1` where the slice's record was stored not vouched for. */
  unvouched: number;
};

/** The row of the slice `ref`, or `undefined` for one with no record. */
const rowOf = (
  context: Context,
  ref: SliceRef,
): SliceRow | undefined =>
  context.statements.selectSlice.get({
    branch: context.branch,
    slice: ref.slice,
    piece: ref.piece,
  }) as SliceRow | undefined;

/** The mark `ref` holds, or `undefined` for a slice with no record. */
const markOf = (context: Context, ref: SliceRef): CurrencyMark | undefined =>
  rowOf(context, ref)?.mark;

/**
 * Sets the mark of `ref`, which has a record. A slice set clean is
 * remembered as having been clean since its record was stored, which no
 * later mark takes back.
 */
const setMark = (context: Context, ref: SliceRef, mark: CurrencyMark): void => {
  const { branch, statements } = context;
  statements.setMark.run({ branch, slice: ref.slice, piece: ref.piece, mark });
  context.touched?.pieces.add(ref.piece);
  if (mark === 0) {
    statements.setWasClean.run({ branch, slice: ref.slice, piece: ref.piece });
  }
};

/** The slices `piece` holds. */
const slicesOf = (
  context: Context,
  piece: string,
): Array<{ slice: string; mark: CurrencyMark }> =>
  context.statements.selectSlicesOfPiece.all({
    branch: context.branch,
    piece,
  }) as Array<{ slice: string; mark: CurrencyMark }>;

/**
 * The other slices that read an instance `ref` writes: one at the slice's
 * own key or narrower beneath it, since those are the instances its
 * computations decide. A slice of the same piece is among them.
 */
const readersOf = (
  context: Context,
  ref: SliceRef,
): Array<SliceRef & { mark: CurrencyMark }> => {
  const { branch, space, statements } = context;
  const readers = statements.selectReadersOfSlice.all({
    branch,
    space,
    piece: ref.piece,
    slice: ref.slice,
    ...atOrBeneath(ref.slice),
  }) as Array<SliceRef & { mark: CurrencyMark }>;
  // A slot at a broader key that the slice's runs wrote is one it decides
  // while its row stands at the slot's head, and its readers are then
  // readers of the slice: one at the slot's own key, whoever wrote it, and
  // one at a viewer's key where this slice is in that viewer's chain.
  const decided = statements.selectReadersOfDecided.all({
    branch,
    space,
    slice: ref.slice,
    piece: ref.piece,
  }) as Array<SliceRef & { mark: CurrencyMark; instance_key: string }>;
  if (decided.length === 0) return readers;
  const seen = new Set(readers.map(refKey));
  for (const { slice, piece, mark, instance_key } of decided) {
    if (
      slice !== instance_key && !sliceChain(slice).includes(ref.slice)
    ) continue;
    const key = refKey({ slice, piece });
    if (seen.has(key)) continue;
    seen.add(key);
    readers.push({ slice, piece, mark });
  }
  return readers;
};

/**
 * The slices whose runs wrote the slot `(id, scopeKey)` from a narrower
 * key, each with the seq its row stands at.
 */
const decidersOf = (
  context: Context,
  id: string,
  scopeKey: string,
): Array<SliceRef & { seq: number }> =>
  context.statements.selectDeciders.all({
    branch: context.branch,
    scope_key: scopeKey,
    id,
  }) as Array<SliceRef & { seq: number }>;

/** Whether `piece` vouches for the instance `(id, scopeKey)`. */
const vouchesFor = (
  context: Context,
  piece: string,
  id: string,
  scopeKey: string,
): boolean => {
  const { branch, statements } = context;
  const slices = scopeKey === ANY_INSTANCE
    ? slicesOf(context, piece).map(({ slice }) => slice)
    : [scopeKey];
  return slices.some((slice) =>
    statements.selectVouch.get({ branch, slice, piece, id }) !== undefined
  );
};

/**
 * Whether the instance `(id, scopeKey)` of this store, a derived document no
 * recorded piece writes, may be one no computation has produced yet: the
 * store holds no such instance, or the instance is a cell of a piece the
 * index holds no record of, by the `result` back-link its piece's setup
 * writes. Setup writes a piece's cells before its computations run, a
 * default into some, and only the piece's record, whose write rows name the
 * cells its computations write, tells those from the rest. An instance read
 * at no one key is not asked about.
 */
const unproduced = (
  context: Context,
  id: string,
  scopeKey: string,
): boolean => {
  if (scopeKey === ANY_INSTANCE) return false;
  const document = read(context.engine, {
    id,
    branch: context.branch,
    scopeKey,
  }) as Record<string, unknown> | null;
  if (document === null) return true;
  const link = document.result;
  if (!isLinkRef(link)) return false;
  const owner = linkRefPayload(link).id;
  return typeof owner !== "string" || slicesOf(context, owner).length === 0;
};

/**
 * What keeps the instance `(id, scopeKey)` of this store from being called
 * current: whether it is a derived document no recorded piece writes that
 * no computation may have produced yet (`unproduced()`), whether a
 * recorded piece computes it and none vouches for it, and the marked slices
 * that decide it. `self` is a slice that does not count
 * against an instance it decides itself.
 */
const staleInstance = (
  context: Context,
  instance: CurrencyInstance & { derived: boolean },
  self?: SliceRef,
): {
  unrecorded: boolean;
  unvouched: boolean;
  producers: SliceRef[];
} => {
  const { branch, statements } = context;
  const { id, scopeKey, derived } = instance;
  const writers = statements.selectWriters.all({ branch, id }) as Array<
    { piece: string }
  >;
  // The recording runtime knows a document as derived only while its writer
  // is loaded there, so every read is looked up among the recorded writers.
  // A derived document none of them writes is written by something the
  // index has no record of: a computation of a piece no record names, one
  // that writes outside its declared surface, a setup run, a handler. It is
  // read as an input, which marks its readers when it changes, and is stale
  // only while no computation has produced it, so that a reader does not
  // pass on what its piece's setup left before the piece ran.
  if (writers.length === 0) {
    return {
      unrecorded: derived && unproduced(context, id, scopeKey),
      unvouched: false,
      producers: [],
    };
  }
  let vouched = false;
  const producers: SliceRef[] = [];
  for (const { piece } of writers) {
    vouched ||= vouchesFor(context, piece, id, scopeKey);
    // The instance is as current as each slice of its writer it is resolved
    // under.
    const candidates = scopeKey === ANY_INSTANCE
      ? slicesOf(context, piece)
      : sliceChain(scopeKey).map((slice) => ({
        slice,
        mark: markOf(context, { piece, slice }),
      }));
    for (const { slice, mark } of candidates) {
      if (mark === undefined) continue;
      if (piece === self?.piece && slice === self.slice) continue;
      if (mark !== 0) producers.push({ piece, slice });
    }
  }
  // A slot a slice's run wrote from another key is as current as that
  // slice, while its row stands at the slot's head: a row behind it answers
  // for nothing, since another run wrote the slot since. A reader at a
  // viewer's key sees the slot as the slices of that viewer's chain decided
  // it, and a reader at the slot's own key as whichever slice holds it.
  if (scopeKey !== ANY_INSTANCE) {
    const viewer = self !== undefined && self.slice !== scopeKey
      ? sliceChain(self.slice)
      : undefined;
    const head = headOfInstance(context, id, scopeKey);
    for (const decider of decidersOf(context, id, scopeKey)) {
      if (decider.seq < head) continue;
      if (viewer !== undefined && !viewer.includes(decider.slice)) continue;
      vouched = true;
      // A slot the reading slice decides itself does not count against it.
      if (decider.piece === self?.piece && decider.slice === self.slice) {
        continue;
      }
      const mark = markOf(context, decider);
      if (mark !== undefined && mark !== 0) {
        producers.push({ piece: decider.piece, slice: decider.slice });
      }
    }
  }
  // A stored value some computation writes is current only while a clean run
  // of that computation stands behind it. A record taken while the
  // computation was not running drops that, whatever the slice's mark.
  return { unrecorded: false, unvouched: !vouched, producers };
};

/**
 * Whether `ref` read an instance of another space that its source reported
 * stale upstream, or has reported nothing of.
 */
const readsStaleImport = (context: Context, ref: SliceRef): boolean => {
  const { branch, space, statements } = context;
  const foreign = statements.selectForeignReads.all({
    branch,
    space,
    slice: ref.slice,
    piece: ref.piece,
  }) as Array<
    { entity_space: string; entity: string; entity_scope_key: string }
  >;
  return foreign.some(({ entity_space, entity, entity_scope_key }) =>
    (statements.selectImport.get({
      branch,
      source: entity_space,
      id: entity,
      scope_key: entity_scope_key,
    }) as { stale: number } | undefined)?.stale !== 0
  );
};

/**
 * What keeps an input of `ref` from being called current: whether it read a
 * derived document no recorded piece writes that no computation may have
 * produced yet, whether it read an instance that a recorded piece computes
 * and none vouches for, whether it read an
 * instance of another space that its source reported stale upstream or has
 * reported nothing of, and the other marked slices that decide an instance
 * it read.
 */
const staleInputsOf = (
  context: Context,
  ref: SliceRef,
): {
  unrecorded: boolean;
  unvouched: boolean;
  upstream: boolean;
  producers: SliceRef[];
} => {
  const { branch, space, statements } = context;
  const reads = statements.selectLocalReads.all({
    branch,
    space,
    slice: ref.slice,
    piece: ref.piece,
  }) as Array<{ entity: string; entity_scope_key: string; derived: number }>;
  let unrecorded = false;
  let unvouched = false;
  const producers = new Map<string, SliceRef>();
  for (const { entity, entity_scope_key, derived } of reads) {
    // The piece's own result document is its pattern pointer, which no
    // computation decides.
    if (entity === ref.piece) continue;
    const found = staleInstance(context, {
      id: entity,
      scopeKey: entity_scope_key,
      derived: derived === 1,
    }, ref);
    unrecorded ||= found.unrecorded;
    unvouched ||= found.unvouched;
    for (const producer of found.producers) {
      producers.set(refKey(producer), producer);
    }
  }
  return {
    unrecorded,
    unvouched,
    upstream: readsStaleImport(context, ref),
    producers: [...producers.values()],
  };
};

/**
 * The reads that keep `ref`, a slice marked `1`, from being current, where
 * every one of them is of an instance another recorded piece is to bring
 * up to date: one a piece that is behind on its own rows decides, or one a
 * recorded piece writes and none vouches for, as a viewer's own instance
 * is before that piece has run for the viewer. They are the reads `ref`
 * made of such an instance, and those made by each slice marked `1`
 * between `ref` and such a piece. Starting those pieces is then what can
 * clear `ref`, and starting its own piece is not. `undefined` where
 * something else keeps `ref` stale: a derived document no recorded piece
 * writes and no computation may have produced, an instance of another
 * space, a read that names no one instance, an instance of a piece whose
 * record was stored not vouched for, or nothing at all.
 */
const upstreamReadsOf = (
  context: Context,
  ref: SliceRef,
): Array<Omit<CurrencyUpstreamRead, "reader">> | undefined => {
  const { branch, space, statements } = context;
  const found = new Map<string, Omit<CurrencyUpstreamRead, "reader">>();
  const seen = new Set([refKey(ref)]);
  const queue = [ref];
  while (queue.length > 0) {
    const at = queue.pop()!;
    const inputs = staleInputsOf(context, at);
    if (inputs.unrecorded || inputs.upstream) return undefined;
    const reads = statements.selectLocalReads.all({
      branch,
      space,
      slice: at.slice,
      piece: at.piece,
    }) as Array<{ entity: string; entity_scope_key: string; derived: number }>;
    for (const { entity, entity_scope_key, derived } of reads) {
      if (entity === at.piece) continue;
      const { unvouched, producers } = staleInstance(context, {
        id: entity,
        scopeKey: entity_scope_key,
        derived: derived === 1,
      }, at);
      /** Notes that the read is of an instance `piece` is to bring up to date. */
      const note = (piece: string) =>
        found.set(
          [at.slice, entity_scope_key, entity, piece].join("\0"),
          {
            slice: at.slice,
            id: entity,
            scopeKey: entity_scope_key,
            piece,
          },
        );
      if (unvouched) {
        // No clean run stands behind the instance, so each recorded piece
        // that writes the document is one to run for it. A document the
        // slice's own piece alone writes has nothing upstream.
        const writers =
          (statements.selectWriters.all({ branch, id: entity }) as Array<
            { piece: string }
          >).filter(({ piece }) => piece !== at.piece);
        if (entity_scope_key === ANY_INSTANCE || writers.length === 0) {
          return undefined;
        }
        for (const { piece } of writers) {
          // A writer recorded for the instance's key and not vouched for
          // has run for it, and a further run vouches for no more.
          const ran = sliceChain(entity_scope_key).some((slice) =>
            rowOf(context, { piece, slice })?.unvouched === 1
          );
          if (ran) return undefined;
          note(piece);
        }
      }
      for (const producer of producers) {
        const row = rowOf(context, producer);
        if (row?.mark === 1) {
          const key = refKey(producer);
          if (!seen.has(key)) {
            seen.add(key);
            queue.push(producer);
          }
          continue;
        }
        // A slice whose record was stored not vouched for stays marked
        // however often its piece runs, so starting that piece clears
        // nothing.
        if (row?.unvouched === 1) return undefined;
        if (entity_scope_key === ANY_INSTANCE) return undefined;
        note(producer.piece);
      }
    }
  }
  return found.size === 0 ? undefined : [...found.values()];
};

/**
 * For each slice `hasStaleInput()` last found waiting on an input of this
 * store, the read it was found waiting on, by engine and by `refKey()`.
 *
 * A slice that reads what many pieces write is asked about once for each of
 * those pieces that is stored clean, and goes on waiting on the same read
 * through nearly all of them. Asking about that read first makes each of
 * those answers one row's work, where walking the slice's reads to it again
 * makes storing the records of a board the square of its size.
 *
 * An entry is a place to look first and nothing more: the read is looked up
 * and judged again each time, so an entry that outlived the slice's rows, or
 * a transaction that rolled back, costs one lookup and is dropped.
 */
const waitingReads = new WeakMap<
  Engine,
  Map<string, { entity: string; scopeKey: string }>
>();

/**
 * Whether an input of `ref` is one the index cannot call current, with each
 * slice in `assumed` taken as clean. It answers from what `staleInputsOf()`
 * gathers, and stops at the first input that decides it: a slice is asked on
 * every record stored and on every walk downstream, and one that waits on
 * something it read goes on waiting whatever its other reads say. The read
 * it stopped at the last time is asked about first (`waitingReads`).
 */
const hasStaleInput = (
  context: Context,
  ref: SliceRef,
  assumed?: ReadonlyMap<string, SliceRef>,
): boolean => {
  const { branch, space, statements } = context;

  /** Whether `ref` waits on its read of the instance `(entity, scopeKey)`. */
  const waitsOn = (
    entity: string,
    scopeKey: string,
    derived: boolean,
  ): boolean => {
    // The piece's own result document is its pattern pointer, which no
    // computation decides.
    if (entity === ref.piece) return false;
    const found = staleInstance(
      context,
      { id: entity, scopeKey, derived },
      ref,
    );
    return found.unrecorded || found.unvouched ||
      found.producers.some((producer) =>
        assumed?.has(refKey(producer)) !== true
      );
  };

  let waiting = waitingReads.get(context.engine);
  if (waiting === undefined) {
    waiting = new Map();
    waitingReads.set(context.engine, waiting);
  }
  const key = refKey(ref);
  const last = waiting.get(key);
  if (last !== undefined) {
    const row = statements.selectLocalRead.get({
      branch,
      space,
      slice: ref.slice,
      piece: ref.piece,
      entity: last.entity,
      entity_scope_key: last.scopeKey,
    }) as { derived: number } | undefined;
    if (
      row !== undefined &&
      waitsOn(last.entity, last.scopeKey, row.derived === 1)
    ) return true;
    waiting.delete(key);
  }
  if (readsStaleImport(context, ref)) return true;
  const reads = statements.selectLocalReads.all({
    branch,
    space,
    slice: ref.slice,
    piece: ref.piece,
  }) as Array<{ entity: string; entity_scope_key: string; derived: number }>;
  for (const { entity, entity_scope_key, derived } of reads) {
    if (!waitsOn(entity, entity_scope_key, derived === 1)) continue;
    waiting.set(key, { entity, scopeKey: entity_scope_key });
    return true;
  }
  return false;
};

/** The pieces that enclose `piece`. */
const underOf = (context: Context, piece: string): string[] =>
  (context.statements.selectUnder.all({
    branch: context.branch,
    piece,
  }) as Array<{ root: string }>).map((row) => row.root);

/**
 * Marks `1` every clean slice downstream of the slices in `from`, each of
 * which has just become marked: the readers of what they write, the readers
 * of what those write, and so on. A slice that was marked before this walk
 * is where it stops. `seqs` gains each slice marked, at the lowest seq of a
 * slice that marks it, and a slice `seqs` already holds at a higher seq is
 * lowered to it.
 */
const markDownstream = (
  context: Context,
  from: readonly SliceRef[],
  seqs: Map<string, { ref: SliceRef; seq: number }>,
): void => {
  // Lowest seq first, so the first seq a slice is given is the lowest one
  // that reaches it through slices this walk marks.
  const sources = [...from].sort((a, b) =>
    (seqs.get(refKey(a))?.seq ?? Infinity) -
    (seqs.get(refKey(b))?.seq ?? Infinity)
  );
  for (const source of sources) {
    const queue = [source];
    while (queue.length > 0) {
      const ref = queue.pop()!;
      const seq = seqs.get(refKey(ref))?.seq;
      for (const reader of readersOf(context, ref)) {
        const key = refKey(reader);
        const next = { piece: reader.piece, slice: reader.slice };
        if (reader.mark === 0) {
          setMark(context, next, 1);
          if (seq !== undefined) seqs.set(key, { ref: next, seq });
          queue.push(next);
          continue;
        }
        // A slice this advance marked at a later seq is stale from the
        // earlier one, and so is what reads it.
        const known = seqs.get(key);
        if (seq !== undefined && known !== undefined && seq < known.seq) {
          seqs.set(key, { ref: next, seq });
          queue.push(next);
        }
      }
    }
  }
};

/**
 * Clears every slice marked `1` downstream of the slices in `from`, each of
 * which has just become clean, that is left with no stale input. A slice
 * marked `2` is where the walk stops.
 */
const clearDownstream = (
  context: Context,
  from: readonly SliceRef[],
): void => {
  const queue = [...from];
  while (queue.length > 0) {
    const ref = queue.pop()!;
    for (const reader of readersOf(context, ref)) {
      if (reader.mark !== 1) continue;
      const next = { piece: reader.piece, slice: reader.slice };
      // An earlier step of this walk may have cleared it already.
      if (markOf(context, next) !== 1 || hasStaleInput(context, next)) continue;
      setMark(context, next, 0);
      queue.push(next);
    }
  }
};

/**
 * Brings the marks up to the store's head and to the time of the call, and
 * moves the cursor to the head. A slice past the time its record expires at
 * is marked `2` with what is downstream of it, and reported at a seq above
 * the head: no input the store holds made it stale. Runs inside the
 * caller's transaction.
 */
const advance = (context: Context): CurrencyMarked[] => {
  const { branch, space, statements } = context;
  const head = serverSeq(context.engine);
  const cursor =
    (statements.selectCursor.get({ branch }) as { seq: number } | undefined)
      ?.seq;
  const slices =
    (statements.countSlices.get({ branch }) as { count: number }).count;
  // An index that holds rows it tells its readers and no cursor starts over
  // with its records dropped (`open()` in `engine.ts`). Each such row says
  // what those records made of its instance, so each is brought up to date.
  if (cursor === undefined && context.touched !== undefined) {
    const exported = statements.selectExportedIds.all({ branch }) as Array<
      { id: string }
    >;
    for (const { id } of exported) context.touched.ids.add(id);
  }
  const seqs = new Map<string, { ref: SliceRef; seq: number }>();
  const becameMarked: SliceRef[] = [];
  if (slices > 0) {
    const expired = statements.selectExpired.all({
      branch,
      now: context.now,
    }) as SliceRef[];
    for (const { slice, piece } of expired) {
      const ref = { piece, slice };
      statements.deleteExpiry.run({ branch, slice, piece });
      const mark = markOf(context, ref);
      if (mark === undefined || mark === 2) continue;
      setMark(context, ref, 2);
      seqs.set(refKey(ref), { ref, seq: head + 1 });
      if (mark === 0) becameMarked.push(ref);
    }
  }
  // With nothing recorded and no instance another space reads, nothing
  // depends on what the store holds above the cursor, so the cursor moves
  // without reading a revision.
  const changes = cursor === undefined || cursor >= head ||
      (slices === 0 && context.touched === undefined)
    ? []
    : statements.selectChangedSince.all({
      branch,
      seq: cursor,
    }) as Array<
      { id: string; scope_key: string; lowest: number; highest: number }
    >;
  for (const { id, scope_key, lowest, highest } of changes) {
    context.touched?.ids.add(id);
    const behind = [
      ...statements.selectReadersBehind.all({
        branch,
        space,
        id,
        scope_key,
        seq: highest,
      }) as Array<SliceRef & { seq: number }>,
      // An instance is vouched for in the slice at its own scope key.
      ...(statements.selectVouchesBehind.all({
        branch,
        scope_key,
        id,
        seq: highest,
      }) as Array<{ piece: string; seq: number }>).map((row) => ({
        ...row,
        slice: scope_key,
      })),
    ];
    for (const row of behind) {
      const ref = { piece: row.piece, slice: row.slice };
      const key = refKey(ref);
      // The first revision above the row is at `lowest` when the row is
      // below every revision read here, and somewhere above the row's own
      // seq otherwise.
      const seq = Math.max(row.seq + 1, lowest);
      const known = seqs.get(key);
      if (known === undefined || seq < known.seq) seqs.set(key, { ref, seq });
      const mark = markOf(context, ref);
      if (mark === undefined || mark === 2) continue;
      setMark(context, ref, 2);
      if (mark === 0) becameMarked.push(ref);
    }
  }
  markDownstream(context, becameMarked, seqs);
  if (cursor !== head) statements.upsertCursor.run({ branch, seq: head });
  const under = new Map<string, string[]>();
  return [...seqs.values()].map(({ ref, seq }) => {
    let roots = under.get(ref.piece);
    if (roots === undefined) {
      roots = underOf(context, ref.piece);
      under.set(ref.piece, roots);
    }
    return {
      piece: ref.piece,
      slice: ref.slice,
      seq,
      under: roots,
      ...(markOf(context, ref) === 1 && { upstream: true as const }),
    };
  });
};

/** The context for `engine`, whose store is `space`'s. */
const contextFor = (engine: Engine, space: string): Context => ({
  engine,
  branch: DEFAULT_BRANCH,
  space,
  statements: preparedFor(engine),
  now: Date.now(),
});

/**
 * The prepared statements of each engine. A judgment asks about each of its
 * roots with a call of its own, and gathering the statements for each call
 * looks every one of them up again.
 */
const prepared = new WeakMap<Engine, Statements>();

/** The prepared statements over the index, for `engine`, gathered once. */
const preparedFor = (engine: Engine): Statements => {
  let statements = prepared.get(engine);
  if (statements === undefined) {
    statements = statementsFor(engine);
    prepared.set(engine, statements);
  }
  return statements;
};

/**
 * The context of a call that changes the index. It keeps what the call
 * touches where the store tells another space of any instance, and such a
 * call ends its transaction with `refreshTouched()`.
 */
const changingContextFor = (engine: Engine, space: string): Context => {
  const context = contextFor(engine, space);
  const exports = context.statements.selectAnyExport.get({
    branch: context.branch,
  }) !== undefined;
  return exports
    ? { ...context, touched: { ids: new Set(), pieces: new Set() } }
    : context;
};

/**
 * Brings the marks up to the store's head: every slice with a row behind a
 * revision above the cursor is marked `2`, and every clean slice downstream
 * of one that became marked is marked `1`.
 *
 * @returns The slices whose rows a revision was found ahead of, and the
 * slices marked downstream of them.
 */
export const advanceCurrencyCursor = (
  engine: Engine,
  options: { space: string },
): CurrencyMarked[] => {
  const context = changingContextFor(engine, options.space);
  let marked: CurrencyMarked[] = [];
  engine.database.transaction(() => {
    marked = advance(context);
    refreshTouched(context);
  }).immediate();
  return marked;
};

/**
 * Stores `batch`, replacing the rows of each slice it names as a set, and
 * each piece's write rows, after bringing the marks up to the store's head.
 * A viewer's slice a piece holds and its record does not name keeps its rows
 * and its mark. So does a `space` slice that is clean and of the batch's
 * epoch, under a record that is vouched for. Any other `space` slice a
 * record does not name is replaced by one that read nothing, as is the
 * missing one of a piece with no record.
 *
 * A row takes the seq its instance's head stands at when every revision of
 * the instance above `batch.asOf` is one `batch.seen` names. Otherwise a
 * commit the recording loop had not seen leaves the slice marked `2`: a read
 * row then takes `batch.asOf`, and a vouch row keeps the seq the piece last
 * answered for the instance at, or is not written for a piece that never
 * did. A vouch row does not move up to a head that a commit other than a
 * derivation put there: the piece did not write what the store holds, so the
 * slice stays marked until it does. A vouch row a record no longer names is
 * released and kept, so that is still known when the piece vouches for the
 * instance again.
 *
 * A slice whose record names a time it expires at is stored with that time,
 * and marked `2` by the first call that brings the marks up to date at or
 * after it. One whose time has passed already is stored marked `2`.
 *
 * A read row for an instance of another space takes the seq its record
 * names. The slice is marked `2` where that seq is below the head the
 * instance's source last reported, where the record names no seq, and where
 * the source has reported nothing of the instance, which `registerCurrencyReads()`
 * and `applyCurrencyImports()` see to before a record is stored.
 *
 * A slice with every row current is `1` while an input of it is stale and
 * `0` otherwise. An input is stale while a marked slice decides it, while a
 * recorded piece computes it and none vouches for it, and while it is an
 * instance of another space that its source reported stale upstream: a
 * slice that read an instance the batch stopped vouching for is marked `1`.
 * A slice that became clean clears the slices marked `1` downstream of it
 * that are left with no stale input.
 */
export const storeCurrencyRecords = (
  engine: Engine,
  batch: CurrencyBatch,
): CurrencyStored => {
  const context = changingContextFor(engine, batch.space);
  const { branch, statements } = context;
  const seen = new Set(batch.seen);
  const result: CurrencyStored = {
    marked: [],
    falseClean: [],
    blocked: [],
    blockedBy: [],
    behind: [],
    unread: [],
  };

  /** Each head `headOf()` has read, by instance. */
  const heads = new Map<string, number>();

  /** The head seq of the instance `(id, scopeKey)`, `0` for none. */
  const headOf = (id: string, scopeKey: string): number => {
    const key = `${scopeKey}\0${id}`;
    let head = heads.get(key);
    if (head === undefined) {
      head = (scopeKey === ANY_INSTANCE
        ? statements.selectHighestHead.get({ branch, id }) as
          | { seq: number | null }
          | undefined
        : statements.selectInstanceHead.get({
          branch,
          id,
          scope_key: scopeKey,
        }) as { seq: number } | undefined)?.seq ?? 0;
      heads.set(key, head);
    }
    return head;
  };

  /** The seqs of the revisions of the instance `(id, scopeKey)` above `seq`. */
  const revisionsAbove = (
    id: string,
    scopeKey: string,
    seq: number,
  ): number[] =>
    headOf(id, scopeKey) <= seq
      ? []
      : ((scopeKey === ANY_INSTANCE
        ? statements.selectAnyRevisionSeqsAbove.all({ branch, id, seq })
        : statements.selectRevisionSeqsAbove.all({
          branch,
          id,
          scope_key: scopeKey,
          seq,
        })) as Array<{ seq: number }>).map((row) => row.seq);

  /** Whether the commit at `seq` is a serving loop's derivation. */
  const isDerivation = (seq: number): boolean =>
    seen.has(seq) ||
    (statements.selectCommitClass.get({ seq }) as
        | { class: string }
        | undefined)?.class === "derived";

  /** Whether a serving loop's derivation ever wrote the instance. */
  const derivedBefore = (id: string, scopeKey: string): boolean =>
    statements.selectDerivationOfInstance.get({
        branch,
        id,
        scope_key: scopeKey,
      }) !== undefined ||
    batch.seen.some((seq) =>
      statements.selectRevisionAt.get({
        branch,
        id,
        scope_key: scopeKey,
        seq,
      }) !== undefined
    );

  /** Each standing `standingOf()` has worked out, by instance. */
  const standing = new Map<string, { seq: number; unseen: boolean }>();

  /**
   * The seq a row for the instance `(id, scopeKey)` takes, and whether a
   * commit the batch had not seen leaves it behind. The seq is the batch's
   * `asOf` where one does, which a read row takes and a vouch row does not.
   */
  const standingOf = (
    id: string,
    scopeKey: string,
  ): { seq: number; unseen: boolean } => {
    const key = `${scopeKey}\0${id}`;
    let known = standing.get(key);
    if (known !== undefined) return known;
    const unseen = revisionsAbove(id, scopeKey, batch.asOf).some((seq) =>
      !seen.has(seq)
    );
    known = unseen
      ? { seq: batch.asOf, unseen: true }
      : { seq: headOf(id, scopeKey), unseen: false };
    standing.set(key, known);
    return known;
  };

  /**
   * Whether every write the commit at `seq` made to the instance
   * `(id, scopeKey)` is one it attributes to a run at the scope key `slice`.
   */
  const writtenAs = (
    id: string,
    scopeKey: string,
    seq: number,
    slice: string,
  ): boolean => {
    const writes = statements.selectRevisionWriters.all({
      branch,
      id,
      scope_key: scopeKey,
      seq,
    }) as Array<{ op_index: number; annotations: string | null }>;
    return writes.every(({ op_index, annotations }) =>
      runKeyOf(annotations, op_index) === slice
    );
  };

  /**
   * Whether `ref`, clean since its last record, wrote an instance it
   * answered for again, to a value other than the one it held, with nothing
   * it read having changed. `decides` are the instances at another key that
   * the record being stored names as ones `ref` decides. Read before the
   * rows of `ref` are replaced.
   *
   * An instance at the slice's own key counts whichever derivation wrote
   * it. One at another key is shared with the runs of other slices, any of
   * which may write it as it decides, so it counts only where the slice's
   * own run is known to have written it: every revision above the slice's
   * row is attributed to a run at the slice's key, and the record names the
   * instance as one that holds what the slice's run left. Where another
   * slice's run wrote it in between, what the slice's run then wrote may
   * have been prompted by that write, and is not counted.
   */
  const wroteAgainUnprompted = (
    ref: SliceRef,
    decides: readonly CurrencyInstance[],
  ): boolean => {
    /** The instances at its own key the slice vouched for. */
    const vouched = (statements.selectVouches.all({
      branch,
      slice: ref.slice,
      piece: ref.piece,
    }) as Array<{ id: string; seq: number; held: number }>).filter((row) =>
      row.held === 1
    ).map(({ id, seq }) => ({ id, scopeKey: ref.slice, seq }));

    /** The instances at another key it answered for that were written since. */
    const decided = (statements.selectDecidesBehind.all({
      branch,
      slice: ref.slice,
      piece: ref.piece,
    }) as Array<{ id: string; instance_key: string; seq: number }>).map((
      { id, instance_key, seq },
    ) => ({ id, scopeKey: instance_key, seq }));

    // A revision that is no derivation is a change from outside, and
    // whatever the piece wrote after it was prompted.
    for (const { id, scopeKey, seq } of [...vouched, ...decided]) {
      const above = revisionsAbove(id, scopeKey, seq);
      if (above.some((revision) => !isDerivation(revision))) return false;
    }
    const written = new Set(
      (statements.selectWrites.all({ branch, piece: ref.piece }) as Array<
        { id: string }
      >).map((row) => row.id),
    );
    // What decided the instance was read by the slice at its key, or by a
    // broader one it is resolved under.
    for (const slice of sliceChain(ref.slice)) {
      const reads = statements.selectReads.all({
        branch,
        slice,
        piece: ref.piece,
      }) as Array<
        { entity_space: string; entity: string; entity_scope_key: string } & {
          seq: number;
        }
      >;
      for (const row of reads) {
        if (row.entity_space !== batch.space) {
          // A change the instance's own space reported, or one it could
          // not be asked about, is one that may have prompted the write.
          const imported = statements.selectImport.get({
            branch,
            source: row.entity_space,
            id: row.entity,
            scope_key: row.entity_scope_key,
          }) as { head: number; stale: number } | undefined;
          if (
            imported === undefined || imported.head > row.seq ||
            imported.stale !== 0
          ) return false;
          continue;
        }
        if (written.has(row.entity)) {
          // A piece does not run for a viewer who holds no instance of its
          // result document. The write that makes the instance is that of
          // whoever instantiates the piece for them, and it prompts what
          // the piece then writes.
          if (
            row.entity === ref.piece &&
            row.entity_scope_key !== ANY_INSTANCE &&
            headOf(row.entity, row.entity_scope_key) > row.seq &&
            read(engine, {
                id: row.entity,
                scopeKey: row.entity_scope_key as ScopeKey,
                seq: row.seq,
              }) === null
          ) return false;
          continue;
        }
        if (headOf(row.entity, row.entity_scope_key) > row.seq) return false;
      }
    }

    /**
     * Whether the instance holds another document than it did at `seq`. A
     * start derives every output of a piece afresh, those of a slice that
     * was current among them, so an instance written again as it stood is
     * no sign that the stored value was stale.
     */
    const differs = (
      { id, scopeKey, seq }: CurrencyInstance & { seq: number },
    ): boolean =>
      headOf(id, scopeKey) > seq &&
      !sameDocument(
        read(engine, { id, scopeKey: scopeKey as ScopeKey, seq }),
        read(engine, { id, scopeKey: scopeKey as ScopeKey }),
      );

    return vouched.some(differs) ||
      decided.some((slot) =>
        decides.some(({ id, scopeKey }) =>
          id === slot.id && scopeKey === slot.scopeKey
        ) &&
        revisionsAbove(slot.id, slot.scopeKey, slot.seq).every((revision) =>
          writtenAs(slot.id, slot.scopeKey, revision, ref.slice)
        ) && differs(slot)
      );
  };

  engine.database.transaction(() => {
    result.marked = advance(context);

    /**
     * Whether a record of `record`'s piece that names no `space` slice
     * leaves the one the piece holds as it is. No live computation of the
     * piece ran at the space's key when such a record was taken, so it has
     * nothing to put in the slice's place.
     *
     * A slice that is clean and of the batch's epoch is kept. Keeping it
     * makes nothing servable that its rows do not prove: they are the rows a
     * clean run left, the advance above has just brought the marks up to the
     * store's head, and every later change to an instance the slice read or
     * vouches for marks it as it marks the slice of a viewer who is away.
     *
     * Any other slice is replaced by one that read nothing. It passes no
     * judgment as it stands, and it would stay so for as long as no session
     * demands what its computations wrote, with its piece started on every
     * demand for the rest of it.
     */
    const keepsSpaceSlice = (record: CurrencyRecord): boolean => {
      const held = rowOf(context, { piece: record.piece, slice: SPACE_SLICE });
      return record.vouched && held !== undefined && held.mark === 0 &&
        held.epoch === batch.epoch;
    };

    /**
     * The slices each record stores: the ones it names, and a `space` slice
     * that read nothing for a record that names none, unless the piece
     * holds one the record leaves as it is.
     */
    const stored = batch.records.map((record) => ({
      record,
      slices: record.slices.some((slice) => slice.key === SPACE_SLICE) ||
          keepsSpaceSlice(record)
        ? record.slices
        : [
          { key: SPACE_SLICE, vouched: true, reads: [], vouches: [] },
          ...record.slices,
        ],
    }));
    const wasClean = stored.flatMap(({ record, slices }) =>
      slices.map((slice) => ({
        ref: { piece: record.piece, slice: slice.key },
        decides: slice.decides ?? [],
      }))
    ).filter(({ ref }) => rowOf(context, ref)?.was_clean === 1);
    result.falseClean = [
      ...new Set(
        wasClean.filter(({ ref, decides }) =>
          wroteAgainUnprompted(ref, decides)
        ).map(({ ref }) => ref.piece),
      ),
    ];

    const refs: SliceRef[] = [];
    const behind = new Set<string>();
    const unread = new Set<string>();
    /** The instances a slice of the batch vouched for and no longer does. */
    const dropped: CurrencyInstance[] = [];
    for (const { record, slices } of stored) {
      const { piece } = record;
      // What the piece wrote before is told of as well as what it writes
      // now.
      if (context.touched !== undefined) {
        context.touched.pieces.add(piece);
        const before = statements.selectWrites.all({ branch, piece }) as Array<
          { id: string }
        >;
        for (const { id } of before) context.touched.ids.add(id);
      }
      statements.deleteUnder.run({ branch, piece });
      statements.deleteWrites.run({ branch, piece });
      for (const root of record.under) {
        if (root !== piece) statements.insertUnder.run({ branch, piece, root });
      }
      if (record.followsOrigin === true) {
        statements.insertOrigin.run({ branch, piece });
      } else {
        statements.deleteOrigin.run({ branch, piece });
      }
      for (const id of record.writes) {
        statements.insertWrite.run({ branch, piece, id, owned: 0 });
      }
      for (const id of record.owned) {
        statements.insertWrite.run({ branch, piece, id, owned: 1 });
      }
      for (const slice of slices) {
        const ref = { piece, slice: slice.key };
        // A vouch row outlives the record that stops vouching for its
        // instance, released, so the seq the piece last answered for the
        // instance at is still known when it vouches again.
        const lastVouches = new Map(
          (statements.selectVouches.all({
            branch,
            slice: slice.key,
            piece,
          }) as Array<{ id: string; seq: number; held: number }>).map((
            row,
          ) => [row.id, row]),
        );
        const vouching = new Set(slice.vouches);
        for (const [id, row] of lastVouches) {
          if (row.held === 1 && !vouching.has(id)) {
            dropped.push({ id, scopeKey: slice.key });
          }
        }
        statements.deleteReads.run({ branch, slice: slice.key, piece });
        const before = statements.selectSourcesOfPieceSlice.all({
          branch,
          slice: slice.key,
          piece,
        }) as Array<{ source: string }>;
        for (const { source } of before) {
          if (!slice.reads.some((read) => read.space === source)) {
            unread.add(source);
          }
        }
        statements.deleteSliceSources.run({ branch, slice: slice.key, piece });
        statements.releaseVouches.run({ branch, slice: slice.key, piece });
        let unseen = false;
        let overwritten = false;
        // A read in another space is one the slice can be vouched for with
        // only where the record names the seq it was made at and the source
        // has said where the instance stands.
        let foreign = false;
        let behindSource = false;
        // The piece's own result document is an input of every slice of it:
        // its pattern pointer decides what the piece computes.
        const reads: CurrencyRead[] = [
          {
            space: batch.space,
            id: piece,
            scopeKey: SPACE_SLICE,
            derived: false,
          },
          ...slice.reads,
        ];
        for (const read of reads) {
          const local = read.space === batch.space;
          const at = local
            ? standingOf(read.id, read.scopeKey)
            : { seq: read.seq ?? 0, unseen: false };
          unseen ||= at.unseen;
          if (!local) {
            statements.insertSliceSource.run({
              branch,
              slice: slice.key,
              piece,
              source: read.space,
            });
            const imported = statements.selectImport.get({
              branch,
              source: read.space,
              id: read.id,
              scope_key: read.scopeKey,
            }) as { head: number } | undefined;
            if (read.seq === undefined || imported === undefined) {
              foreign = true;
            } else if (read.seq < imported.head) behindSource = true;
          }
          statements.insertRead.run({
            branch,
            slice: slice.key,
            piece,
            entity_space: read.space,
            entity: read.id,
            entity_scope_key: read.scopeKey,
            derived: read.derived ? 1 : 0,
            seq: at.seq,
          });
        }
        for (const id of slice.vouches) {
          const at = standingOf(id, slice.key);
          unseen ||= at.unseen;
          const last = lastVouches.get(id)?.seq;
          if (at.unseen) {
            // A record taken below a commit to the instance answers for it
            // at no seq. Its row keeps the seq the piece last answered at,
            // and is not written for a piece that never did, so that a
            // later record does not read the commit as an overwrite of
            // something this one vouched for.
            if (last !== undefined) {
              statements.upsertVouch.run({
                branch,
                slice: slice.key,
                piece,
                id,
                seq: last,
              });
            }
            continue;
          }
          // A head no derivation put there, above the seq the piece last
          // answered for the instance at, or on an instance a derivation
          // had written, is an overwrite from outside, which the piece's
          // writer did not answer: it reads nothing it writes, so the
          // change did not wake it. An instance no derivation ever wrote
          // is one a client computed before a serving loop did, which a
          // clean run that left it alone agrees with.
          const outside = at.seq > 0 && !isDerivation(at.seq) &&
            (last === undefined ? derivedBefore(id, slice.key) : at.seq > last);
          overwritten ||= outside;
          statements.upsertVouch.run({
            branch,
            slice: slice.key,
            piece,
            id,
            seq: outside ? last ?? 0 : at.seq,
          });
        }
        // The broader slots the slice's runs wrote are answered for here,
        // each at the seq it stands at. A record replaces them whole. One
        // that holds a later write is stored behind every head: the row
        // answers for nothing, and keeps the slot from being taken for one
        // the slice's runs never wrote.
        statements.deleteDecides.run({ branch, slice: slice.key, piece });
        for (const { id, scopeKey } of slice.superseded ?? []) {
          statements.insertDecide.run({
            branch,
            slice: slice.key,
            piece,
            id,
            instance_key: scopeKey,
            seq: SUPERSEDED_SEQ,
          });
        }
        for (const { id, scopeKey } of slice.decides ?? []) {
          const at = standingOf(id, scopeKey);
          unseen ||= at.unseen;
          statements.insertDecide.run({
            branch,
            slice: slice.key,
            piece,
            id,
            instance_key: scopeKey,
            seq: at.seq,
          });
        }
        const vouched = record.vouched && slice.vouched && !foreign;
        if (vouched && unseen && !overwritten) behind.add(piece);
        // A record that reaches the store at or after the time it expires
        // at was current for no time at all.
        const expired = slice.expiresAt !== undefined &&
          slice.expiresAt <= context.now;
        const clean = vouched && !unseen && !overwritten && !behindSource &&
          !expired;
        statements.deleteExpiry.run({ branch, slice: slice.key, piece });
        if (clean && slice.expiresAt !== undefined) {
          statements.insertExpiry.run({
            branch,
            slice: slice.key,
            piece,
            expires_at: slice.expiresAt,
          });
        }
        statements.upsertSlice.run({
          branch,
          slice: slice.key,
          piece,
          mark: clean ? 0 : 2,
          epoch: batch.epoch,
          unvouched: vouched ? 0 : 1,
        });
        refs.push(ref);
      }
    }
    result.behind = [...behind];
    result.unread = [...unread];

    // A slice of the batch can read what another piece of it writes, and so
    // can a slice an earlier batch of the same point stored, so the `1`
    // marks among them are settled together: every such slice is taken as
    // clean, and one with an input that is stale even so is dropped, until
    // none is.
    const pieces = new Set(batch.records.map((record) => record.piece));
    const settling = new Map<string, SliceRef>();
    for (const piece of batch.settle ?? []) {
      for (const { slice, mark } of slicesOf(context, piece)) {
        if (mark !== 1) continue;
        const ref = { piece, slice };
        settling.set(refKey(ref), ref);
      }
    }
    const assumed = new Map<string, SliceRef>(settling);
    for (const ref of refs) {
      if (markOf(context, ref) === 0) assumed.set(refKey(ref), ref);
    }
    for (let changed = true; changed;) {
      changed = false;
      for (const [key, ref] of assumed) {
        if (!hasStaleInput(context, ref, assumed)) continue;
        assumed.delete(key);
        // A dropped slice is a marked producer from here on.
        if (!settling.has(key)) setMark(context, ref, 1);
        changed = true;
      }
    }
    const settled = [...settling].filter(([key]) => assumed.has(key)).map((
      [, ref],
    ) => ref);
    for (const ref of settled) setMark(context, ref, 0);
    const blocked = new Set<string>();
    const blockedBy = new Set<string>();
    const marked: SliceRef[] = [];
    const clean: SliceRef[] = [];
    for (const ref of refs) {
      const mark = markOf(context, ref);
      if (mark === 0) {
        statements.setWasClean.run({
          branch,
          slice: ref.slice,
          piece: ref.piece,
        });
        clean.push(ref);
        continue;
      }
      marked.push(ref);
      if (mark === 1) {
        blocked.add(ref.piece);
        for (const producer of staleInputsOf(context, ref).producers) {
          if (!pieces.has(producer.piece)) blockedBy.add(producer.piece);
        }
      }
    }
    // A slice that read an instance the batch stopped vouching for rests on
    // a value no clean run stands behind any longer.
    const recorded = new Set(refs.map(refKey));
    for (const { id, scopeKey } of dropped) {
      const readers = statements.selectReadersOfInstance.all({
        branch,
        space: batch.space,
        id,
        scope_key: scopeKey,
      }) as SliceRef[];
      for (const { piece, slice } of readers) {
        const ref = { piece, slice };
        if (recorded.has(refKey(ref)) || markOf(context, ref) !== 0) continue;
        if (!hasStaleInput(context, ref)) continue;
        setMark(context, ref, 1);
        marked.push(ref);
      }
    }
    // A record can name writes its piece's last one did not, so a marked
    // slice marks its readers whether or not it was marked before.
    markDownstream(context, marked, new Map());
    clearDownstream(context, [...clean, ...settled]);
    result.blocked = [...blocked];
    result.blockedBy = [...blockedBy];
    refreshTouched(context);
  }).immediate();
  return result;
};

/** The head seq of the instance `(id, scopeKey)` of this store, `0` for none. */
const headOfInstance = (
  context: Context,
  id: string,
  scopeKey: string,
): number => {
  const { branch, statements } = context;
  return (scopeKey === ANY_INSTANCE
    ? statements.selectHighestHead.get({ branch, id }) as
      | { seq: number | null }
      | undefined
    : statements.selectInstanceHead.get({ branch, id, scope_key: scopeKey }) as
      | { seq: number }
      | undefined)?.seq ?? 0;
};

/**
 * Brings what this store tells its readers of the instance `(id, scopeKey)`
 * up to date, moving the row to a new position where its head or its
 * staleness changed. A row this writes first takes position `0`: the space
 * registering the instance is handed the row, and no other reads it yet.
 * The marks are read as they stand.
 */
const refreshExport = (
  context: Context,
  { id, scopeKey }: CurrencyInstance,
): void => {
  const { branch, statements } = context;
  const head = headOfInstance(context, id, scopeKey);
  // A document's id says it is derived only under the id form that names
  // one, so a derivation having written the instance says so too.
  const derived = id.startsWith(COMPUTED_ID_PREFIX) ||
    (scopeKey !== ANY_INSTANCE &&
      statements.selectDerivationOfInstance.get({
          branch,
          id,
          scope_key: scopeKey,
        }) !== undefined);
  const found = staleInstance(context, { id, scopeKey, derived });
  const stale =
    found.unrecorded || found.unvouched || found.producers.length > 0 ? 1 : 0;
  const row = statements.selectExport.get({
    branch,
    id,
    scope_key: scopeKey,
  }) as
    | { head: number; stale: number }
    | undefined;
  if (row !== undefined && row.head === head && row.stale === stale) return;
  statements.upsertExport.run({
    branch,
    id,
    scope_key: scopeKey,
    head,
    stale,
    position: row === undefined ? 0 : highestPosition(context) + 1,
  });
};

/** The highest position a row this store tells its readers of moved to. */
const highestPosition = (context: Context): number =>
  (context.statements.selectHighestPosition.get({
    branch: context.branch,
  }) as { position: number | null } | undefined)?.position ?? 0;

/**
 * Brings what this store tells its readers up to date for everything the
 * call touched: each instance of a document a commit wrote, and each
 * instance a touched piece writes or wrote. Ends the transaction of every
 * call that changes the index, so a row is behind the marks only inside
 * one.
 */
const refreshTouched = (context: Context): void => {
  const { branch, statements, touched } = context;
  if (touched === undefined) return;
  for (const piece of touched.pieces) {
    const writes = statements.selectWrites.all({ branch, piece }) as Array<
      { id: string }
    >;
    for (const { id } of writes) touched.ids.add(id);
  }
  for (const id of touched.ids) {
    const rows = statements.selectExportsOfId.all({ branch, id }) as Array<
      { scope_key: string }
    >;
    for (const { scope_key } of rows) {
      refreshExport(context, { id, scopeKey: scope_key });
    }
  }
  touched.pieces.clear();
  touched.ids.clear();
};

/** What this store tells its readers of the instance `(id, scopeKey)`. */
const exportOf = (
  context: Context,
  { id, scopeKey }: CurrencyInstance,
): CurrencyExport => {
  const row = context.statements.selectExport.get({
    branch: context.branch,
    id,
    scope_key: scopeKey,
  }) as { head: number; stale: number };
  return { id, scopeKey, head: row.head, stale: row.stale !== 0 };
};

/**
 * Registers `reads`, instances of `space`'s store that slices of the space
 * `reader` read, after bringing the marks up to the store's head.
 *
 * @returns What the store reports of each of them now, and the slices of
 * `space` the advance marked. A change that lands after this returns is one
 * a later pull by `reader` returns.
 */
export const registerCurrencyReads = (
  engine: Engine,
  options: {
    space: string;
    reader: string;
    reads: readonly CurrencyInstance[];
  },
): { entries: CurrencyExport[]; marked: CurrencyMarked[] } => {
  const context = changingContextFor(engine, options.space);
  const { branch, statements } = context;
  const entries: CurrencyExport[] = [];
  let marked: CurrencyMarked[] = [];
  engine.database.transaction(() => {
    marked = advance(context);
    refreshTouched(context);
    for (const instance of options.reads) {
      statements.insertReader.run({
        branch,
        reader: options.reader,
        id: instance.id,
        scope_key: instance.scopeKey,
      });
      refreshExport(context, instance);
      entries.push(exportOf(context, instance));
    }
  }).immediate();
  return { entries, marked };
};

/**
 * Returns what `space`'s store reports of the instances the space `reader`
 * registered whose head or staleness changed after the position `since`,
 * after bringing the marks up to the store's head. `dropped` are instances
 * `reader` no longer reads, whose registrations are removed.
 *
 * @returns The entries that changed, the position to pull from next, and
 * the slices of `space` the advance marked.
 */
export const pullCurrencyExports = (
  engine: Engine,
  options: {
    space: string;
    reader: string;
    since: number;
    dropped?: readonly CurrencyInstance[];
  },
): {
  entries: CurrencyExport[];
  position: number;
  marked: CurrencyMarked[];
} => {
  const context = changingContextFor(engine, options.space);
  const { branch, statements } = context;
  let pulled: {
    entries: CurrencyExport[];
    position: number;
    marked: CurrencyMarked[];
  } = { entries: [], position: options.since, marked: [] };
  engine.database.transaction(() => {
    const marked = advance(context);
    refreshTouched(context);
    for (const { id, scopeKey } of options.dropped ?? []) {
      statements.deleteReader.run({
        branch,
        reader: options.reader,
        id,
        scope_key: scopeKey,
      });
    }
    const changed = statements.selectExportsSince.all({
      branch,
      reader: options.reader,
      since: options.since,
    }) as Array<
      { id: string; scope_key: string; head: number; stale: number }
    >;
    pulled = {
      entries: changed.map(({ id, scope_key, head, stale }) => ({
        id,
        scopeKey: scope_key,
        head,
        stale: stale !== 0,
      })),
      position: Math.max(options.since, highestPosition(context)),
      marked,
    };
  }).immediate();
  return pulled;
};

/**
 * The spaces that registered an instance of `space`'s store whose row moved
 * to a position above `since`, each with the highest such position, and the
 * highest position any row moved to. The rows are read as they stand: each
 * call that changes the index leaves them current.
 */
export const selectCurrencyReadersMoved = (
  engine: Engine,
  options: { space: string; since: number },
): {
  readers: Array<{ reader: string; position: number }>;
  position: number;
} => {
  const context = contextFor(engine, options.space);
  return {
    readers: context.statements.selectReadersMovedSince.all({
      branch: context.branch,
      since: options.since,
    }) as Array<{ reader: string; position: number }>,
    position: Math.max(options.since, highestPosition(context)),
  };
};

/**
 * Applies `entries`, what the space `source` reported of instances of its
 * store, to `space`'s index. A slice with a read row behind an entry's head
 * is marked `2`, a clean one that read an instance reported stale upstream
 * is marked `1`, and one marked `1` that is left with no stale input is
 * cleared, each with what is downstream of it. `position`, where given, is
 * the position of `source` to pull from next.
 *
 * @returns The pieces with a slice this marked.
 */
export const applyCurrencyImports = (
  engine: Engine,
  options: {
    space: string;
    source: string;
    entries: readonly CurrencyExport[];
    position?: number;
  },
): string[] => {
  const context = changingContextFor(engine, options.space);
  const { branch, statements } = context;
  const { source } = options;
  const marked = new Map<string, SliceRef>();
  engine.database.transaction(() => {
    /** The slices that read an entry and stood marked `1`. */
    const waiting = new Map<string, SliceRef>();
    for (const { id, scopeKey, head, stale } of options.entries) {
      // An entry that says what the index already holds of the instance
      // changes no slice: each that read it was marked, or left waiting,
      // when the entry was first applied or when its own record was stored.
      // A registration returns every instance a batch read, so most entries
      // are such.
      const held = statements.selectImport.get({
        branch,
        source,
        id,
        scope_key: scopeKey,
      }) as { head: number; stale: number } | undefined;
      if (held?.head === head && (held.stale !== 0) === stale) continue;
      statements.upsertImport.run({
        branch,
        source,
        id,
        scope_key: scopeKey,
        head,
        stale: stale ? 1 : 0,
      });
      const readers = statements.selectReadersOfImport.all({
        branch,
        source,
        id,
        scope_key: scopeKey,
      }) as Array<SliceRef & { seq: number }>;
      for (const { slice, piece, seq } of readers) {
        const ref = { piece, slice };
        const mark = markOf(context, ref);
        if (mark === undefined) continue;
        if (seq < head) {
          if (mark === 2) continue;
          setMark(context, ref, 2);
          marked.set(refKey(ref), ref);
        } else if (stale && mark === 0) {
          setMark(context, ref, 1);
          marked.set(refKey(ref), ref);
        } else if (mark === 1) waiting.set(refKey(ref), ref);
      }
    }
    markDownstream(context, [...marked.values()], new Map());
    const cleared: SliceRef[] = [];
    for (const ref of waiting.values()) {
      if (markOf(context, ref) !== 1 || hasStaleInput(context, ref)) continue;
      setMark(context, ref, 0);
      cleared.push(ref);
    }
    clearDownstream(context, cleared);
    if (options.position !== undefined) {
      statements.upsertSourcePosition.run({
        branch,
        source,
        position: options.position,
      });
    }
    refreshTouched(context);
  }).immediate();
  return [...new Set([...marked.values()].map((ref) => ref.piece))];
};

/**
 * The pieces of `space` whose records say they write the document `id`, at
 * any instance of it.
 */
export const selectCurrencyWriters = (
  engine: Engine,
  options: { space: string; id: string },
): string[] => {
  const context = contextFor(engine, options.space);
  return (context.statements.selectWriters.all({
    branch: context.branch,
    id: options.id,
  }) as Array<{ piece: string }>).map(({ piece }) => piece);
};

/**
 * The piece of `space` that derives the document `id`: the one piece whose
 * record says it writes the document, at any instance of it. `undefined`
 * when the records of no piece or of several say they write it.
 */
export const selectCurrencyDeriver = (
  engine: Engine,
  options: { space: string; id: string },
): string | undefined => {
  const writers = selectCurrencyWriters(engine, options);
  return writers.length === 1 ? writers[0] : undefined;
};

/**
 * Whether nothing the index or the store holds says that a computation
 * writes the document `id` of `space`: its id is no `computed:` one, no
 * piece's record says it writes it, no recorded slice read it as a document
 * a computation writes, and no serving loop's derivation wrote its shared
 * instance. Such a document holds what clients wrote, and nothing derives
 * it.
 */
export const isUnderivedDocument = (
  engine: Engine,
  options: { space: string; id: string },
): boolean => {
  const { id, space } = options;
  if (id.startsWith(COMPUTED_ID_PREFIX)) return false;
  const { branch, statements } = contextFor(engine, space);
  return statements.selectWriters.get({ branch, id }) === undefined &&
    statements.selectReadAsDerived.get({ branch, space, entity: id }) ===
      undefined &&
    statements.selectDerivationOfInstance.get({
        branch,
        id,
        scope_key: SPACE_SLICE,
      }) === undefined;
};

/**
 * What `space`'s index last worked out of the instance `(id, scopeKey)` for
 * the spaces that read it, or `undefined` where no space registered it: its
 * head, and whether a piece here computes it and does not answer for it at
 * present. It is as of the index's last change, so a commit since may have
 * moved the instance.
 */
export const selectCurrencyExport = (
  engine: Engine,
  options: { space: string } & CurrencyInstance,
): { head: number; stale: boolean } | undefined => {
  const context = contextFor(engine, options.space);
  const row = context.statements.selectExport.get({
    branch: context.branch,
    id: options.id,
    scope_key: options.scopeKey,
  }) as { head: number; stale: number } | undefined;
  return row === undefined
    ? undefined
    : { head: row.head, stale: row.stale !== 0 };
};

/**
 * The position of the space `source` that `space`'s index last pulled
 * through, `0` where it has pulled nothing.
 */
export const selectCurrencySourcePosition = (
  engine: Engine,
  options: { space: string; source: string },
): number => {
  const context = contextFor(engine, options.space);
  return (context.statements.selectSourcePosition.get({
    branch: context.branch,
    source: options.source,
  }) as { position: number } | undefined)?.position ?? 0;
};

/**
 * The other spaces that the slices at `slices`, of any piece of `space`,
 * read, or that any slice of it read where `slices` is left out.
 */
export const selectCurrencySources = (
  engine: Engine,
  options: { space: string; slices?: Iterable<string> },
): string[] => {
  const context = contextFor(engine, options.space);
  if (options.slices === undefined) {
    return (context.statements.selectSources.all({
      branch: context.branch,
    }) as Array<{ source: string }>).map((row) => row.source);
  }
  const sources = new Set<string>();
  for (const slice of options.slices) {
    const rows = context.statements.selectSourcesOfSlice.all({
      branch: context.branch,
      slice,
    }) as Array<{ source: string }>;
    for (const { source } of rows) sources.add(source);
  }
  return [...sources];
};

/**
 * Removes, from what `space`'s index holds of the space `source`, each
 * instance no slice reads any longer.
 *
 * @returns The instances removed, which `source` is told of so that it
 * drops their registrations.
 */
export const dropUnreadCurrencyImports = (
  engine: Engine,
  options: { space: string; source: string },
): CurrencyInstance[] => {
  const context = contextFor(engine, options.space);
  const { branch, statements } = context;
  const { source } = options;
  const dropped: CurrencyInstance[] = [];
  engine.database.transaction(() => {
    const held = statements.selectImportsOfSource.all({
      branch,
      source,
    }) as Array<{ id: string; scope_key: string }>;
    for (const { id, scope_key } of held) {
      const readers = statements.selectReadersOfImport.all({
        branch,
        source,
        id,
        scope_key,
      });
      if (readers.length > 0) continue;
      statements.deleteImport.run({ branch, source, id, scope_key });
      dropped.push({ id, scopeKey: scope_key });
    }
  }).immediate();
  return dropped;
};

/**
 * Forgets what `space`'s index holds of the space `source`, which cannot be
 * asked any longer, and marks `2` each slice that read it.
 *
 * @returns The pieces with a slice this marked.
 */
export const forgetCurrencySource = (
  engine: Engine,
  options: { space: string; source: string },
): string[] => {
  const context = changingContextFor(engine, options.space);
  const { branch, statements } = context;
  const { source } = options;
  const marked = new Map<string, SliceRef>();
  engine.database.transaction(() => {
    const held = statements.selectImportsOfSource.all({
      branch,
      source,
    }) as Array<{ id: string; scope_key: string }>;
    for (const { id, scope_key } of held) {
      const readers = statements.selectReadersOfImport.all({
        branch,
        source,
        id,
        scope_key,
      }) as SliceRef[];
      for (const { slice, piece } of readers) {
        const ref = { piece, slice };
        const mark = markOf(context, ref);
        if (mark === undefined || mark === 2) continue;
        setMark(context, ref, 2);
        marked.set(refKey(ref), ref);
      }
      statements.deleteImport.run({ branch, source, id, scope_key });
    }
    statements.deleteSourcePosition.run({ branch, source });
    markDownstream(context, [...marked.values()], new Map());
    refreshTouched(context);
  }).immediate();
  return [...new Set([...marked.values()].map((ref) => ref.piece))];
};

/**
 * The instances of the space `source` that `space`'s index holds as told of
 * by it: the ones a slice here read and registered there.
 */
export const selectCurrencyImports = (
  engine: Engine,
  options: { space: string; source: string },
): CurrencyInstance[] => {
  const context = contextFor(engine, options.space);
  return (context.statements.selectImportsOfSource.all({
    branch: context.branch,
    source: options.source,
  }) as Array<{ id: string; scope_key: string }>).map((
    { id, scope_key },
  ) => ({ id, scopeKey: scope_key }));
};

/**
 * Forgets what `space`'s index holds of `instances` of the space `source`,
 * which it may not be told of any longer, and marks `2` each slice that
 * read one. A record stored afterward finds nothing reported of them.
 *
 * @returns The pieces with a slice this marked.
 */
export const forgetCurrencyImports = (
  engine: Engine,
  options: {
    space: string;
    source: string;
    instances: readonly CurrencyInstance[];
  },
): string[] => {
  const context = changingContextFor(engine, options.space);
  const { branch, statements } = context;
  const { source } = options;
  const marked = new Map<string, SliceRef>();
  engine.database.transaction(() => {
    for (const { id, scopeKey } of options.instances) {
      const readers = statements.selectReadersOfImport.all({
        branch,
        source,
        id,
        scope_key: scopeKey,
      }) as SliceRef[];
      for (const { slice, piece } of readers) {
        const ref = { piece, slice };
        const mark = markOf(context, ref);
        if (mark === undefined || mark === 2) continue;
        setMark(context, ref, 2);
        marked.set(refKey(ref), ref);
      }
      statements.deleteImport.run({ branch, source, id, scope_key: scopeKey });
    }
    markDownstream(context, [...marked.values()], new Map());
    refreshTouched(context);
  }).immediate();
  return [...new Set([...marked.values()].map((ref) => ref.piece))];
};

/**
 * Drops the registrations the space `reader` holds of `reads`, instances of
 * `space`'s store, so that `space` tells it nothing more of them.
 */
export const unregisterCurrencyReads = (
  engine: Engine,
  options: {
    space: string;
    reader: string;
    reads: readonly CurrencyInstance[];
  },
): void => {
  const context = contextFor(engine, options.space);
  const { branch, statements } = context;
  engine.database.transaction(() => {
    for (const { id, scopeKey } of options.reads) {
      statements.deleteReader.run({
        branch,
        reader: options.reader,
        id,
        scope_key: scopeKey,
      });
    }
  }).immediate();
};

/**
 * The earliest time, in milliseconds since the epoch, at which a slice of
 * `space` expires, or `undefined` where none does. The marks are brought up
 * to date at or after that time to mark it, which a space that reads this
 * one does by pulling from it.
 */
export const selectCurrencyNextExpiry = (
  engine: Engine,
  options: { space: string },
): number | undefined => {
  const context = contextFor(engine, options.space);
  return (context.statements.selectNextExpiry.get({
    branch: context.branch,
  }) as { expires_at: number | null } | undefined)?.expires_at ?? undefined;
};

/** Why a root is not one the store can serve. */
export type CurrencyRefusal =
  /** The root's piece has no record. */
  | "no-record"
  /** The root's piece is marked for every viewer. */
  | "marked"
  /** The root's piece was recorded under another epoch. */
  | "other-epoch"
  /** A session demands an instance the piece writes and does not vouch for. */
  | "unvouched-instance"
  /** A session demands an instance of an owned cell the store does not hold. */
  | "absent-owned"
  /**
   * A slice a demanded instance is resolved under, of a piece that owns it,
   * is marked or of another epoch.
   */
  | "owner-not-clean";

/**
 * A read that keeps a slice from being current, of an instance another
 * recorded piece is to bring up to date: one a piece behind on its own rows
 * decides, or one a recorded piece writes and none vouches for.
 */
export type CurrencyUpstreamRead = {
  /**
   * The piece whose slice the read keeps stale: a root's piece, a piece
   * beneath a root that a demanded instance is resolved under, or a running
   * piece the judgment was asked about.
   */
  reader: string;

  /**
   * The key of the slice that made the read: a slice of `reader`, or of a
   * piece between `reader` and `piece` that is stale only through this.
   */
  slice: string;

  /** The id of the document read. */
  id: string;

  /** The scope key of the instance read. */
  scopeKey: string;

  /** The piece that writes the instance, and is to run for it. */
  piece: string;
};

/** What a judgment of roots found. */
export type CurrencyJudgment = {
  /** The roots the store can serve. */
  servable: string[];

  /** The roots it cannot, each with the first reason found. */
  refused: Array<{ root: string; reason: CurrencyRefusal }>;

  /**
   * The roots that would pass but for slices that are stale only through
   * what is upstream of them: what the store holds of each is not current,
   * and starting its piece would not make it so. Starting the pieces
   * `upstream` names may. `readers` are the pieces whose slices hold the
   * root, its own piece or pieces beneath it, as `upstream` names them.
   */
  held: Array<{ root: string; readers: string[] }>;

  /**
   * The reads that keep a slice of a root, or of one of the running pieces
   * asked about, stale only through what is upstream of it.
   */
  upstream: CurrencyUpstreamRead[];

  /**
   * The pieces each servable root rests on that record a source origin: its
   * own piece and those beneath it. A root that rests on none has no entry.
   */
  origins: Array<{ root: string; pieces: string[] }>;
};

/**
 * Judges which of `roots` can be served from the store as it stands, with no
 * piece started. `roots` are raw ids of space-scoped result documents, and
 * `rows` are the document instances the sessions of the space demand.
 *
 * A root passes when its piece's `space` slice is clean and of `epoch`, and
 * every demanded instance whose id the piece writes or owns, or a recorded
 * piece beneath it does, is vouched for: each slice of the owner the
 * instance is resolved under is clean and of `epoch`, and the slice at the
 * instance's own key holds a vouch row for a written id, or the store holds
 * a live document for an owned one. A written instance that a narrower
 * slice's run wrote, as a redirect at a broader key is, is answered for by
 * the slices of each demander's own chain that hold a row for it, which are
 * to be current with the slices above them, and by no other viewer's. A
 * slice no demanded instance is resolved
 * under is not read, so the stale slice of a viewer who demands nothing
 * refuses no root. A root is served for every session `rows` covers or for
 * none, so one of them with a stale slice refuses it for all.
 * The marks are read as they stand, so a caller that needs them current
 * advances the cursor first, and brings what the index holds of each space
 * the slices read up to what that space reports.
 *
 * A slice marked `1` whose every stale input a piece behind on its own
 * rows decides refuses no root: a root that passes but for such slices is
 * returned as held, with the reads that keep them stale. `running` are
 * pieces that run already, whose slices are asked about for those reads
 * alone.
 */
export const judgeCurrencyRoots = (
  engine: Engine,
  options: {
    space: string;
    roots: readonly string[];
    /**
     * The demanded instances. `demander` is the narrowest scope key of the
     * pair whose session demands the row, a session's key: a row at the
     * space names no pair, and whose view of a slot is asked about decides
     * which slice answers for it. A row without one is taken as demanded by
     * every pair the narrower keys among the rows name.
     */
    rows: Iterable<CurrencyInstance & { demander?: string }>;
    epoch: string;
    running?: readonly string[];
  },
): CurrencyJudgment => {
  const context = contextFor(engine, options.space);
  const { branch, statements } = context;
  const judgment: CurrencyJudgment = {
    servable: [],
    refused: [],
    held: [],
    upstream: [],
    origins: [],
  };

  /** Whether each slice asked about is stale only upstream, by slice. */
  const upstreamOnly = new Map<string, boolean>();

  /** The pieces a slice of which is stale only upstream. */
  const staleUpstream = new Set<string>();

  /**
   * Whether the slice `ref`, marked `1` and of the epoch, is stale only
   * through what is upstream of it. The reads that keep it so join the
   * judgment the first time it is asked about.
   */
  const staleOnlyUpstream = (ref: SliceRef): boolean => {
    const key = refKey(ref);
    let known = upstreamOnly.get(key);
    if (known === undefined) {
      const reads = upstreamReadsOf(context, ref);
      known = reads !== undefined;
      upstreamOnly.set(key, known);
      if (reads !== undefined) {
        staleUpstream.add(ref.piece);
        for (const read of reads) {
          judgment.upstream.push({ reader: ref.piece, ...read });
        }
      }
    }
    return known;
  };

  /**
   * Whether the row `row` of the slice `ref` refuses nothing: it is of the
   * epoch, and clean or stale only upstream.
   */
  const passes = (
    ref: SliceRef,
    row: { mark: CurrencyMark; epoch: string },
  ): boolean =>
    row.epoch === options.epoch &&
    (row.mark === 0 || (row.mark === 1 && staleOnlyUpstream(ref)));

  for (const piece of options.running ?? []) {
    for (const { slice, mark } of slicesOf(context, piece)) {
      const ref = { piece, slice };
      if (mark !== 1 || rowOf(context, ref)?.epoch !== options.epoch) continue;
      staleOnlyUpstream(ref);
    }
  }
  const candidates: string[] = [];
  for (const root of options.roots) {
    const ref = { piece: root, slice: SPACE_SLICE };
    const row = rowOf(context, ref);
    if (row === undefined) {
      judgment.refused.push({ root, reason: "no-record" });
    } else if (passes(ref, row)) {
      candidates.push(root);
    } else if (row.mark !== 0) {
      judgment.refused.push({ root, reason: "marked" });
    } else {
      judgment.refused.push({ root, reason: "other-epoch" });
    }
  }
  if (candidates.length === 0) return judgment;

  /** Each answer `isCurrent()` has given, by slice. */
  const current = new Map<string, boolean>();

  /**
   * Whether the slice `ref` refuses nothing: it is of the epoch, and clean
   * or stale only upstream. `true` for none.
   */
  const isCurrent = (ref: SliceRef): boolean => {
    const key = refKey(ref);
    let known = current.get(key);
    if (known === undefined) {
      const row = rowOf(context, ref);
      known = row === undefined || passes(ref, row);
      current.set(key, known);
    }
    return known;
  };

  const rows = [...options.rows];

  /**
   * The chain of each pair known only by the narrower keys among the rows,
   * from that key up to the space: who a row that names no demander is
   * taken as demanded by.
   */
  const unnamed = [
    ...new Set(
      rows.filter(({ demander }) => demander === undefined).map((
        { scopeKey },
      ) => scopeKey).filter((key) => key !== SPACE_SLICE),
    ),
  ].map((key) => sliceChain(key));

  /** The chains of the pairs that demand each instance, by instance. */
  const demanding = new Map<string, Map<string, string[]>>();
  for (const { id, scopeKey, demander } of rows) {
    const key = `${scopeKey}\0${id}`;
    let chains = demanding.get(key);
    if (chains === undefined) {
      chains = new Map();
      demanding.set(key, chains);
    }
    if (demander !== undefined) {
      if (!chains.has(demander)) chains.set(demander, sliceChain(demander));
      continue;
    }
    for (const chain of unnamed) chains.set(chain[0], chain);
  }

  /**
   * Why `piece` does not answer for the instance `(id, scopeKey)` it writes,
   * or `undefined` where it does. The slice at the instance's key vouches
   * for what its own runs wrote. A slot a narrower slice's run wrote is
   * decided, for each pair that demands it, by the slices of that pair's
   * chain that hold a row for it: each row is to stand at the slot's head,
   * and each of those slices, and each slice above it, is to be current. A
   * slot only another viewer's slice holds a row for is not answered for.
   */
  const unvouchedFor = (
    piece: string,
    id: string,
    scopeKey: string,
  ): CurrencyRefusal | undefined => {
    const own = statements.selectVouch.get({
      branch,
      slice: scopeKey,
      piece,
      id,
    }) !== undefined;
    const deciders = decidersOf(context, id, scopeKey).filter((decider) =>
      decider.piece === piece
    );
    if (deciders.length === 0) return own ? undefined : "unvouched-instance";
    // Every row the judgment reads is among the demanded ones.
    const viewers = [...demanding.get(`${scopeKey}\0${id}`)!.values()]
      .filter((chain) => chain.includes(scopeKey));
    if (viewers.length === 0) return own ? undefined : "unvouched-instance";
    const head = headOfInstance(context, id, scopeKey);
    for (const chain of viewers) {
      const mine = deciders.filter(({ slice }) => chain.includes(slice));
      if (mine.length === 0) {
        if (!own) return "unvouched-instance";
        continue;
      }
      // A row behind the slot's head answers for nothing: another run wrote
      // the slot since, and a run for this pair would write it as it decides.
      if (mine.some(({ seq }) => seq < head)) return "unvouched-instance";
      const stale = mine.some((decider) =>
        sliceChain(decider.slice).some((slice) => !isCurrent({ piece, slice }))
      );
      if (stale) return "owner-not-clean";
    }
    return undefined;
  };

  /** The pieces that own a demanded instance they do not vouch for. */
  const failing = new Map<string, CurrencyRefusal>();
  const judged = new Set<string>();
  for (const { id, scopeKey } of rows) {
    const key = `${scopeKey}\0${id}`;
    if (judged.has(key)) continue;
    judged.add(key);
    const owners = statements.selectOwners.all({ branch, id }) as Array<
      { piece: string; owned: number }
    >;
    for (const { piece, owned } of owners) {
      if (failing.has(piece)) continue;
      if (
        sliceChain(scopeKey).some((slice) => !isCurrent({ piece, slice }))
      ) {
        failing.set(piece, "owner-not-clean");
      } else if (owned !== 0) {
        if (!isLive(context, id, scopeKey)) failing.set(piece, "absent-owned");
      } else {
        const reason = unvouchedFor(piece, id, scopeKey);
        if (reason !== undefined) failing.set(piece, reason);
      }
    }
  }
  const failingRoots = new Map(failing);
  for (const [piece, reason] of failing) {
    for (const root of underOf(context, piece)) {
      if (!failingRoots.has(root)) failingRoots.set(root, reason);
    }
  }
  // A root rests on its own piece and on the pieces beneath it, so one of
  // those that is stale upstream holds the root.
  const holding = new Map<string, string[]>();
  for (const piece of staleUpstream) {
    for (const root of [piece, ...underOf(context, piece)]) {
      const readers = holding.get(root);
      if (readers === undefined) holding.set(root, [piece]);
      else if (!readers.includes(piece)) readers.push(piece);
    }
  }
  for (const root of candidates) {
    const reason = failingRoots.get(root);
    const readers = holding.get(root);
    if (reason !== undefined) judgment.refused.push({ root, reason });
    else if (readers !== undefined) judgment.held.push({ root, readers });
    else judgment.servable.push(root);
  }
  for (const root of judgment.servable) {
    const beneath = statements.selectBeneath.all({ branch, root }) as Array<
      { piece: string }
    >;
    const pieces = [root, ...beneath.map(({ piece }) => piece)].filter((
      piece,
    ) => statements.selectOrigin.get({ branch, piece }) !== undefined);
    if (pieces.length > 0) judgment.origins.push({ root, pieces });
  }
  return judgment;
};

/** Whether the store holds a live document at `(id, scopeKey)`. */
const isLive = (context: Context, id: string, scopeKey: string): boolean => {
  const head = context.statements.selectHeadOp.get({
    branch: context.branch,
    id,
    scope_key: scopeKey,
  }) as { op: string } | undefined;
  return head !== undefined && head.op !== "delete";
};

/**
 * The row the index holds for the slice `options.slice` of `piece`, the
 * `space` slice by default, or `undefined` when it holds none.
 */
export const selectCurrencyPiece = (
  engine: Engine,
  options: { piece: string; slice?: string },
): CurrencySliceRow | undefined => {
  const row = engine.prepare(`
SELECT mark, epoch FROM currency_slice
WHERE branch = :branch AND slice = :slice AND piece = :piece
`).get({
      branch: DEFAULT_BRANCH,
      slice: options.slice ?? SPACE_SLICE,
      piece: options.piece,
    }) as CurrencySliceRow | undefined;
  return row;
};
