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
 * and a record replaces the slices it names and leaves the others as they
 * are.
 *
 * Rows are identifiers and sequence numbers, overwritten in place, with the
 * slice leading each key: reading one viewer's slices reads no other
 * viewer's rows. Each function here that writes opens its own transaction;
 * none of them runs at admission.
 */

import {
  DEFAULT_BRANCH,
  identityOfScopeKey,
  resolveScopeKey,
  scopeOfScopeKey,
} from "../v2.ts";
import { type Engine, serverSeq } from "./engine.ts";

/**
 * What the index holds about a slice's stored outputs: `0` clean, `1` a piece
 * that writes one of its inputs is marked or unrecorded, `2` one of its own
 * rows is behind its document or the slice was not vouched for.
 */
export type CurrencyMark = 0 | 1 | 2;

/** The slice every recorded piece has, and the scope key of a shared instance. */
const SPACE_SLICE = "space";

/**
 * The scope key of a read whose instance the recording loop could not name.
 * A change to any instance of the document is ahead of such a read.
 */
export const ANY_INSTANCE = "*";

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
   * The slices the loop ran. A record with no `space` slice is stored with
   * one that read nothing. A slice the piece holds and the record does not
   * name is left as it is.
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

  /** The epoch of the recording build. */
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
};

/** What storing a batch found. */
export type CurrencyStored = {
  /** What the advance that precedes the store marked. */
  marked: CurrencyMarked[];

  /**
   * The pieces with a slice that had been clean since its last record, then
   * wrote an instance it vouched for again with no input of its having
   * changed: what it held was not what it computes.
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
 * `key` and each broader scope key an instance at `key` is resolved under,
 * narrowest first: a session's key, its user's, and the space.
 */
const chainOf = (key: string): string[] => {
  if (key === SPACE_SLICE) return [SPACE_SLICE];
  if (scopeOfScopeKey(key) !== "session") return [key, SPACE_SLICE];
  const identity = identityOfScopeKey(key);
  return identity === undefined
    ? [key, SPACE_SLICE]
    : [key, resolveScopeKey("user", identity), SPACE_SLICE];
};

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
SELECT mark, was_clean, epoch FROM currency_slice
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
INSERT INTO currency_slice (branch, slice, piece, mark, was_clean, epoch)
VALUES (:branch, :slice, :piece, :mark, 0, :epoch)
ON CONFLICT (branch, slice, piece)
DO UPDATE SET mark = excluded.mark, was_clean = 0, epoch = excluded.epoch
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
  deleteVouches: engine.prepare(`
DELETE FROM currency_vouch
WHERE branch = :branch AND slice = :slice AND piece = :piece
`),
  insertVouch: engine.prepare(`
INSERT OR REPLACE INTO currency_vouch (branch, slice, piece, id, seq)
VALUES (:branch, :slice, :piece, :id, :seq)
`),
  selectVouch: engine.prepare(`
SELECT seq FROM currency_vouch
WHERE branch = :branch AND slice = :slice AND piece = :piece AND id = :id
`),
  selectVouches: engine.prepare(`
SELECT id, seq FROM currency_vouch
WHERE branch = :branch AND slice = :slice AND piece = :piece
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
  AND r.piece != :piece
  AND (:all = 1 OR r.entity_scope_key = :key
    OR r.entity_scope_key = '${ANY_INSTANCE}'
    OR (r.entity_scope_key >= :lo AND r.entity_scope_key < :hi))
`),
  selectLocalReads: engine.prepare(`
SELECT entity, entity_scope_key, derived FROM currency_read
WHERE branch = :branch AND slice = :slice AND piece = :piece
  AND entity_space = :space
`),
});

/** What the index needs to know to work on one engine's space. */
type Context = {
  engine: Engine;
  branch: string;
  space: string;
  statements: Statements;
};

/** The row of the slice `ref`, or `undefined` for one with no record. */
const rowOf = (
  context: Context,
  ref: SliceRef,
): { mark: CurrencyMark; was_clean: number; epoch: string } | undefined =>
  context.statements.selectSlice.get({
    branch: context.branch,
    slice: ref.slice,
    piece: ref.piece,
  }) as { mark: CurrencyMark; was_clean: number; epoch: string } | undefined;

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
 * The slices of other pieces that read an instance `ref` writes: one at the
 * slice's own key or narrower beneath it, since those are the instances its
 * computations decide.
 */
const readersOf = (
  context: Context,
  ref: SliceRef,
): Array<SliceRef & { mark: CurrencyMark }> =>
  context.statements.selectReadersOfSlice.all({
    branch: context.branch,
    space: context.space,
    piece: ref.piece,
    ...atOrBeneath(ref.slice),
  }) as Array<SliceRef & { mark: CurrencyMark }>;

/**
 * What keeps an input of `ref` from being called current: whether it read a
 * derived document no recorded piece writes, and the marked slices of other
 * pieces that write an instance it read.
 */
const staleInputsOf = (
  context: Context,
  ref: SliceRef,
): { unrecorded: boolean; producers: SliceRef[] } => {
  const { branch, space, statements } = context;
  const reads = statements.selectLocalReads.all({
    branch,
    space,
    slice: ref.slice,
    piece: ref.piece,
  }) as Array<{ entity: string; entity_scope_key: string; derived: number }>;
  let unrecorded = false;
  const producers = new Map<string, SliceRef>();
  for (const { entity, entity_scope_key, derived } of reads) {
    const writers = statements.selectWriters.all({
      branch,
      id: entity,
    }) as Array<{ piece: string }>;
    // The recording runtime knows a document as derived only while its
    // writer is loaded there, so every read is looked up among the recorded
    // writers, and the flag decides only whether a read with none is an
    // input nothing computes or one whose producer is unknown.
    if (writers.length === 0 && derived === 1) unrecorded = true;
    for (const { piece } of writers) {
      if (piece === ref.piece) continue;
      // The instance is as current as each slice of its writer it is
      // resolved under.
      const candidates = entity_scope_key === ANY_INSTANCE
        ? slicesOf(context, piece)
        : chainOf(entity_scope_key).map((slice) => ({
          slice,
          mark: markOf(context, { piece, slice }),
        }));
      for (const { slice, mark } of candidates) {
        if (mark === undefined || mark === 0) continue;
        const producer = { piece, slice };
        producers.set(refKey(producer), producer);
      }
    }
  }
  return { unrecorded, producers: [...producers.values()] };
};

/** Whether an input of `ref` is one the index cannot call current. */
const hasStaleInput = (context: Context, ref: SliceRef): boolean => {
  const { unrecorded, producers } = staleInputsOf(context, ref);
  return unrecorded || producers.length > 0;
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
 * Brings the marks up to the store's head and moves the cursor there. Runs
 * inside the caller's transaction.
 */
const advance = (context: Context): CurrencyMarked[] => {
  const { branch, space, statements } = context;
  const head = serverSeq(context.engine);
  const cursor =
    (statements.selectCursor.get({ branch }) as { seq: number } | undefined)
      ?.seq;
  const slices =
    (statements.countSlices.get({ branch }) as { count: number }).count;
  // With nothing recorded there is nothing to mark, whatever the store holds
  // above the cursor, so the cursor moves without reading a revision.
  if (cursor === undefined || slices === 0) {
    if (cursor !== head) statements.upsertCursor.run({ branch, seq: head });
    return [];
  }
  if (cursor >= head) return [];
  const seqs = new Map<string, { ref: SliceRef; seq: number }>();
  const becameMarked: SliceRef[] = [];
  const changes = statements.selectChangedSince.all({
    branch,
    seq: cursor,
  }) as Array<
    { id: string; scope_key: string; lowest: number; highest: number }
  >;
  for (const { id, scope_key, lowest, highest } of changes) {
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
  statements.upsertCursor.run({ branch, seq: head });
  const under = new Map<string, string[]>();
  return [...seqs.values()].map(({ ref, seq }) => {
    let roots = under.get(ref.piece);
    if (roots === undefined) {
      roots = underOf(context, ref.piece);
      under.set(ref.piece, roots);
    }
    return { piece: ref.piece, slice: ref.slice, seq, under: roots };
  });
};

/** The context for `engine`, whose store is `space`'s. */
const contextFor = (engine: Engine, space: string): Context => ({
  engine,
  branch: DEFAULT_BRANCH,
  space,
  statements: statementsFor(engine),
});

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
  const context = contextFor(engine, options.space);
  let marked: CurrencyMarked[] = [];
  engine.database.transaction(() => {
    marked = advance(context);
  }).immediate();
  return marked;
};

/**
 * Stores `batch`, replacing the rows of each slice it names as a set, and
 * each piece's write rows, after bringing the marks up to the store's head.
 * A slice a piece holds and its record does not name keeps its rows and its
 * mark.
 *
 * A row takes the seq its instance's head stands at when every revision of
 * the instance above `batch.asOf` is one `batch.seen` names, and `batch.asOf`
 * otherwise, so a commit the recording loop had not seen leaves the slice
 * marked `2`. A vouch row does not move up to a head that a commit other
 * than a derivation put there: the piece did not write what the store holds,
 * so the slice stays marked until it does. A slice with every row current is
 * `1` while an input of it is stale and `0` otherwise, and a slice that
 * became clean clears the slices marked `1` downstream of it that are left
 * with no stale input.
 */
export const storeCurrencyRecords = (
  engine: Engine,
  batch: CurrencyBatch,
): CurrencyStored => {
  const context = contextFor(engine, batch.space);
  const { branch, statements } = context;
  const seen = new Set(batch.seen);
  const result: CurrencyStored = {
    marked: [],
    falseClean: [],
    blocked: [],
    blockedBy: [],
    behind: [],
  };

  /** The head seq of the instance `(id, scopeKey)`, `0` for none. */
  const heads = new Map<string, number>();
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

  /**
   * The seq a row for the instance `(id, scopeKey)` takes, and whether a
   * commit the batch had not seen leaves it behind.
   */
  const standing = new Map<string, { seq: number; unseen: boolean }>();
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
   * Whether `ref`, clean since its last record, wrote an instance it
   * vouched for again with nothing it read having changed. Read before its
   * rows are replaced.
   */
  const wroteAgainUnprompted = (ref: SliceRef): boolean => {
    const vouches = statements.selectVouches.all({
      branch,
      slice: ref.slice,
      piece: ref.piece,
    }) as Array<{ id: string; seq: number }>;
    // A revision that is no derivation is a change from outside, and
    // whatever the piece wrote after it was prompted.
    for (const { id, seq } of vouches) {
      const above = revisionsAbove(id, ref.slice, seq);
      if (above.some((revision) => !isDerivation(revision))) return false;
    }
    const written = new Set(
      (statements.selectWrites.all({ branch, piece: ref.piece }) as Array<
        { id: string }
      >).map((row) => row.id),
    );
    // What decided the instance was read by the slice at its key, or by a
    // broader one it is resolved under.
    for (const slice of chainOf(ref.slice)) {
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
        if (row.entity_space !== batch.space || written.has(row.entity)) {
          continue;
        }
        if (headOf(row.entity, row.entity_scope_key) > row.seq) return false;
      }
    }
    return vouches.some(({ id, seq }) => headOf(id, ref.slice) > seq);
  };

  engine.database.transaction(() => {
    /** The slices each record stores: the ones it names, and `space`. */
    const stored = batch.records.map((record) => ({
      record,
      slices: record.slices.some((slice) => slice.key === SPACE_SLICE)
        ? record.slices
        : [
          { key: SPACE_SLICE, vouched: true, reads: [], vouches: [] },
          ...record.slices,
        ],
    }));
    const wasClean = stored.flatMap(({ record, slices }) =>
      slices.map((slice) => ({ piece: record.piece, slice: slice.key }))
    ).filter((ref) => rowOf(context, ref)?.was_clean === 1);
    result.marked = advance(context);
    result.falseClean = [
      ...new Set(
        wasClean.filter(wroteAgainUnprompted).map((ref) => ref.piece),
      ),
    ];

    const refs: SliceRef[] = [];
    const behind = new Set<string>();
    for (const { record, slices } of stored) {
      const { piece } = record;
      statements.deleteUnder.run({ branch, piece });
      statements.deleteWrites.run({ branch, piece });
      for (const root of record.under) {
        if (root !== piece) statements.insertUnder.run({ branch, piece, root });
      }
      for (const id of record.writes) {
        statements.insertWrite.run({ branch, piece, id, owned: 0 });
      }
      for (const id of record.owned) {
        statements.insertWrite.run({ branch, piece, id, owned: 1 });
      }
      for (const slice of slices) {
        const ref = { piece, slice: slice.key };
        const lastVouches = new Map(
          (statements.selectVouches.all({
            branch,
            slice: slice.key,
            piece,
          }) as Array<{ id: string; seq: number }>).map((
            row,
          ) => [row.id, row.seq]),
        );
        statements.deleteReads.run({ branch, slice: slice.key, piece });
        statements.deleteVouches.run({ branch, slice: slice.key, piece });
        let unseen = false;
        let overwritten = false;
        // Nothing marks a slice for a change in another space, so one that
        // read another space is not vouched for, whatever its record says.
        let foreign = false;
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
            : { seq: 0, unseen: false };
          unseen ||= at.unseen;
          foreign ||= !local;
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
          const last = lastVouches.get(id);
          // A head above the last record's that no derivation put there is
          // an overwrite from outside, which the piece's writer did not
          // answer: it reads nothing it writes, so the change did not wake
          // it.
          const outside = !at.unseen && last !== undefined && at.seq > last &&
            !isDerivation(at.seq);
          overwritten ||= outside;
          statements.insertVouch.run({
            branch,
            slice: slice.key,
            piece,
            id,
            seq: outside ? last : at.seq,
          });
        }
        const vouched = record.vouched && slice.vouched && !foreign;
        if (vouched && unseen && !overwritten) behind.add(piece);
        statements.upsertSlice.run({
          branch,
          slice: slice.key,
          piece,
          mark: vouched && !unseen && !overwritten ? 0 : 2,
          epoch: batch.epoch,
        });
        refs.push(ref);
      }
    }
    result.behind = [...behind];

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
        const { unrecorded, producers } = staleInputsOf(context, ref);
        const stale = unrecorded ||
          producers.some((producer) => !assumed.has(refKey(producer)));
        if (!stale) continue;
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
    // A record can name writes its piece's last one did not, so a marked
    // slice marks its readers whether or not it was marked before.
    markDownstream(context, marked, new Map());
    clearDownstream(context, [...clean, ...settled]);
    result.blocked = [...blocked];
    result.blockedBy = [...blockedBy];
  }).immediate();
  return result;
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

/** What a judgment of roots found. */
export type CurrencyJudgment = {
  /** The roots the store can serve. */
  servable: string[];

  /** The roots it cannot, each with the first reason found. */
  refused: Array<{ root: string; reason: CurrencyRefusal }>;
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
 * a live document for an owned one. A slice no demanded instance is resolved
 * under is not read, so one viewer's stale slice refuses no other viewer.
 * The marks are read as they stand, so a caller that needs them current
 * advances the cursor first.
 */
export const judgeCurrencyRoots = (
  engine: Engine,
  options: {
    space: string;
    roots: readonly string[];
    rows: Iterable<CurrencyInstance>;
    epoch: string;
  },
): CurrencyJudgment => {
  const context = contextFor(engine, options.space);
  const { branch, statements } = context;
  const judgment: CurrencyJudgment = { servable: [], refused: [] };
  const candidates: string[] = [];
  for (const root of options.roots) {
    const row = rowOf(context, { piece: root, slice: SPACE_SLICE });
    if (row === undefined) {
      judgment.refused.push({ root, reason: "no-record" });
    } else if (row.mark !== 0) {
      judgment.refused.push({ root, reason: "marked" });
    } else if (row.epoch !== options.epoch) {
      judgment.refused.push({ root, reason: "other-epoch" });
    } else {
      candidates.push(root);
    }
  }
  if (candidates.length === 0) return judgment;

  /** Whether the slice `ref` is clean and of the epoch, `true` for none. */
  const current = new Map<string, boolean>();
  const isCurrent = (ref: SliceRef): boolean => {
    const key = refKey(ref);
    let known = current.get(key);
    if (known === undefined) {
      const row = rowOf(context, ref);
      known = row === undefined ||
        (row.mark === 0 && row.epoch === options.epoch);
      current.set(key, known);
    }
    return known;
  };

  /** The pieces that own a demanded instance they do not vouch for. */
  const failing = new Map<string, CurrencyRefusal>();
  const judged = new Set<string>();
  for (const { id, scopeKey } of options.rows) {
    const key = `${scopeKey}\0${id}`;
    if (judged.has(key)) continue;
    judged.add(key);
    const owners = statements.selectOwners.all({ branch, id }) as Array<
      { piece: string; owned: number }
    >;
    for (const { piece, owned } of owners) {
      if (failing.has(piece)) continue;
      if (
        chainOf(scopeKey).some((slice) => !isCurrent({ piece, slice }))
      ) {
        failing.set(piece, "owner-not-clean");
      } else if (owned !== 0) {
        if (!isLive(context, id, scopeKey)) failing.set(piece, "absent-owned");
      } else if (
        statements.selectVouch.get({
          branch,
          slice: scopeKey,
          piece,
          id,
        }) === undefined
      ) {
        failing.set(piece, "unvouched-instance");
      }
    }
  }
  const failingRoots = new Map(failing);
  for (const [piece, reason] of failing) {
    for (const root of underOf(context, piece)) {
      if (!failingRoots.has(root)) failingRoots.set(root, reason);
    }
  }
  for (const root of candidates) {
    const reason = failingRoots.get(root);
    if (reason === undefined) judgment.servable.push(root);
    else judgment.refused.push({ root, reason });
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
