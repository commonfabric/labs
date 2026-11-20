/**
 * The currency index (docs/specs/server-side-execution/serving-loop.md §3b):
 * which stored outputs a serving loop vouched for, per piece, and the marks
 * that say a piece's stored outputs may no longer be what it would compute.
 *
 * A serving loop stores a record for a piece at a quiescent point: what the
 * piece read, what it writes, and which document instances it vouches for.
 * A change to a document the piece read or writes marks the piece, and a
 * marked piece marks each piece that reads a document it writes, so a mark
 * reaches a piece through documents no session demands. Storing a new record
 * is the only thing that clears a mark.
 *
 * Rows are identifiers and sequence numbers, overwritten in place per piece.
 * Each function here that writes opens its own transaction; none of them runs
 * at admission.
 */

import { DEFAULT_BRANCH } from "../v2.ts";
import { type Engine, serverSeq } from "./engine.ts";

/**
 * What the index holds about a piece's stored outputs: `0` clean, `1` a piece
 * that writes one of its inputs is marked or unrecorded, `2` one of its own
 * rows is behind its document or the piece was not vouched for.
 */
export type CurrencyMark = 0 | 1 | 2;

/** One document a piece read. */
export type CurrencyRead = {
  /** The space the document is in. */
  space: string;

  /** The document's id. */
  id: string;

  /** Whether some computation writes the document. */
  derived: boolean;
};

/** One document instance, as a demand row or a vouch names it. */
export type CurrencyInstance = {
  /** The document's id. */
  id: string;

  /** The instance's scope key. */
  scopeKey: string;
};

/** What a serving loop recorded about one piece at a quiescent point. */
export type CurrencyRecord = {
  /** The raw id of the piece's result document. */
  piece: string;

  /** The pieces that enclose this one. */
  under: readonly string[];

  /**
   * Whether the loop vouches for the piece at all. A record that does not is
   * stored marked `2`, whatever its rows say.
   */
  vouched: boolean;

  /** The documents the piece's live computations read. */
  reads: readonly CurrencyRead[];

  /**
   * The ids in the declared write surface of every computation registered
   * under the piece, whether or not it has run.
   */
  writes: readonly string[];

  /** The ids of the cells the piece owns and owes a default. */
  owned: readonly string[];

  /** The document instances a live, clean computation of the piece wrote. */
  vouches: readonly CurrencyInstance[];
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

/** A piece an advance of the cursor marked. */
export type CurrencyMarked = {
  /** The piece. */
  piece: string;

  /**
   * A seq at or below the first change that marks the piece: an input at
   * this seq or above is one the piece's stored outputs do not reflect.
   */
  seq: number;

  /** The pieces that enclose it. */
  under: string[];
};

/** What storing a batch found. */
export type CurrencyStored = {
  /** What the advance that precedes the store marked. */
  marked: CurrencyMarked[];

  /**
   * The pieces that had been clean since their last record, then wrote an
   * instance they vouched for again with no input of theirs having changed:
   * what they held was not what they compute.
   */
  falseClean: string[];

  /** The pieces of the batch stored `1`, with every row of theirs current. */
  blocked: string[];

  /**
   * The marked pieces outside the batch that keep one of `blocked` at `1`.
   * A loop that runs one records it together with what it blocks, since
   * pieces that read each other's writes settle only in one batch.
   */
  blockedBy: string[];

  /**
   * The vouched-for pieces of the batch stored marked `2` for no reason but
   * a commit above `asOf` that the batch does not name as seen. A record of
   * one taken at a quiescent point that covers that commit is not marked
   * for it.
   */
  behind: string[];
};

/** One piece's row, for a caller that inspects the index. */
export type CurrencyPieceRow = {
  /** The piece's mark. */
  mark: CurrencyMark;

  /** The epoch it was recorded under. */
  epoch: string;
};

type Statements = ReturnType<typeof statementsFor>;

/** The prepared statements over the index, for `engine`. */
const statementsFor = (engine: Engine) => ({
  selectPiece: engine.prepare(`
SELECT mark, epoch FROM currency_piece
WHERE branch = :branch AND piece = :piece
`),
  countPieces: engine.prepare(`
SELECT COUNT(*) AS count FROM currency_piece WHERE branch = :branch
`),
  upsertPiece: engine.prepare(`
INSERT INTO currency_piece (branch, piece, mark, was_clean, epoch)
VALUES (:branch, :piece, :mark, 0, :epoch)
ON CONFLICT (branch, piece)
DO UPDATE SET mark = excluded.mark, was_clean = 0, epoch = excluded.epoch
`),
  setWasClean: engine.prepare(`
UPDATE currency_piece SET was_clean = 1
WHERE branch = :branch AND piece = :piece
`),
  selectWasClean: engine.prepare(`
SELECT was_clean FROM currency_piece
WHERE branch = :branch AND piece = :piece
`),
  selectCommitClass: engine.prepare(`
SELECT class FROM "commit" WHERE seq = :seq
`),
  selectInstanceHead: engine.prepare(`
SELECT seq FROM head
WHERE branch = :branch AND id = :id AND scope_key = :scope_key
`),
  setMark: engine.prepare(`
UPDATE currency_piece SET mark = :mark
WHERE branch = :branch AND piece = :piece
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
DELETE FROM currency_read WHERE branch = :branch AND piece = :piece
`),
  insertRead: engine.prepare(`
INSERT INTO currency_read (branch, piece, entity_space, entity, derived, seq)
VALUES (:branch, :piece, :entity_space, :entity, :derived, :seq)
ON CONFLICT (branch, piece, entity_space, entity)
DO UPDATE SET derived = MAX(derived, excluded.derived), seq = excluded.seq
`),
  deleteWrites: engine.prepare(`
DELETE FROM currency_write WHERE branch = :branch AND piece = :piece
`),
  insertWrite: engine.prepare(`
INSERT INTO currency_write (branch, piece, id, owned, seq)
VALUES (:branch, :piece, :id, :owned, :seq)
ON CONFLICT (branch, piece, id)
DO UPDATE SET owned = MIN(owned, excluded.owned), seq = excluded.seq
`),
  deleteVouches: engine.prepare(`
DELETE FROM currency_vouch WHERE branch = :branch AND piece = :piece
`),
  insertVouch: engine.prepare(`
INSERT OR IGNORE INTO currency_vouch (branch, piece, id, scope_key)
VALUES (:branch, :piece, :id, :scope_key)
`),
  selectVouch: engine.prepare(`
SELECT 1 AS found FROM currency_vouch
WHERE branch = :branch AND piece = :piece AND id = :id
  AND scope_key = :scope_key
`),
  selectCursor: engine.prepare(`
SELECT seq FROM currency_cursor WHERE branch = :branch
`),
  upsertCursor: engine.prepare(`
INSERT INTO currency_cursor (branch, seq) VALUES (:branch, :seq)
ON CONFLICT (branch) DO UPDATE SET seq = excluded.seq
`),
  selectChangedSince: engine.prepare(`
SELECT id, MIN(seq) AS lowest, MAX(seq) AS highest FROM revision
WHERE branch = :branch AND seq > :seq
GROUP BY id
`),
  selectRevisionSeqsAbove: engine.prepare(`
SELECT DISTINCT seq FROM revision
WHERE branch = :branch AND id = :id AND seq > :seq
`),
  selectVouches: engine.prepare(`
SELECT id, scope_key FROM currency_vouch
WHERE branch = :branch AND piece = :piece
`),
  selectHighestHead: engine.prepare(`
SELECT MAX(seq) AS seq FROM head WHERE branch = :branch AND id = :id
`),
  selectHeadOp: engine.prepare(`
SELECT op FROM head
WHERE branch = :branch AND id = :id AND scope_key = :scope_key
`),
  selectReadersBehind: engine.prepare(`
SELECT piece, seq FROM currency_read
WHERE branch = :branch AND entity_space = :space AND entity = :id
  AND seq < :seq
`),
  selectWritersBehind: engine.prepare(`
SELECT piece, seq FROM currency_write
WHERE branch = :branch AND id = :id AND owned = 0 AND seq < :seq
`),
  // The three joins below name their order and their index: each starts
  // from one piece's rows, and a plan that starts from the other table
  // reads every row of the branch.
  selectReadersOfPiece: engine.prepare(`
SELECT DISTINCT r.piece AS piece
FROM currency_write w
CROSS JOIN currency_read r INDEXED BY idx_currency_read_entity
  ON r.branch = w.branch AND r.entity_space = :space AND r.entity = w.id
CROSS JOIN currency_piece p
  ON p.branch = r.branch AND p.piece = r.piece
WHERE w.branch = :branch AND w.piece = :piece AND w.owned = 0
  AND r.piece != :piece AND p.mark = :mark
`),
  selectAllReadersOfPiece: engine.prepare(`
SELECT DISTINCT r.piece AS piece, p.mark AS mark
FROM currency_write w
CROSS JOIN currency_read r INDEXED BY idx_currency_read_entity
  ON r.branch = w.branch AND r.entity_space = :space AND r.entity = w.id
CROSS JOIN currency_piece p
  ON p.branch = r.branch AND p.piece = r.piece
WHERE w.branch = :branch AND w.piece = :piece AND w.owned = 0
  AND r.piece != :piece
`),
  selectMarkedProducers: engine.prepare(`
SELECT DISTINCT w.piece AS piece
FROM currency_read r
CROSS JOIN currency_write w INDEXED BY idx_currency_write_id
  ON w.branch = r.branch AND w.id = r.entity AND w.owned = 0
CROSS JOIN currency_piece p
  ON p.branch = w.branch AND p.piece = w.piece
WHERE r.branch = :branch AND r.piece = :piece AND r.entity_space = :space
  AND w.piece != :piece AND p.mark > 0
`),
  selectUnrecordedInput: engine.prepare(`
SELECT 1 AS found
FROM currency_read r
WHERE r.branch = :branch AND r.piece = :piece AND r.entity_space = :space
  AND r.derived = 1
  AND NOT EXISTS (
    SELECT 1 FROM currency_write w
    WHERE w.branch = r.branch AND w.id = r.entity AND w.owned = 0
  )
LIMIT 1
`),
  selectReads: engine.prepare(`
SELECT entity_space, entity, seq FROM currency_read
WHERE branch = :branch AND piece = :piece
`),
  selectWrites: engine.prepare(`
SELECT id, owned, seq FROM currency_write
WHERE branch = :branch AND piece = :piece
`),
  selectOwners: engine.prepare(`
SELECT w.piece AS piece, w.owned AS owned, p.mark AS mark, p.epoch AS epoch
FROM currency_write w
JOIN currency_piece p
  ON p.branch = w.branch AND p.piece = w.piece
WHERE w.branch = :branch AND w.id = :id
`),
});

/** What the index needs to know to work on one engine's space. */
type Context = {
  engine: Engine;
  branch: string;
  space: string;
  statements: Statements;
};

/** The mark `piece` holds, or `undefined` for a piece with no record. */
const markOf = (context: Context, piece: string): CurrencyMark | undefined =>
  (context.statements.selectPiece.get({ branch: context.branch, piece }) as
    | { mark: CurrencyMark }
    | undefined)?.mark;

/**
 * Sets the mark of `piece`, which has a record. A piece set clean is
 * remembered as having been clean since its record was stored, which no
 * later mark takes back.
 */
const setMark = (context: Context, piece: string, mark: CurrencyMark): void => {
  const { branch, statements } = context;
  statements.setMark.run({ branch, piece, mark });
  if (mark === 0) statements.setWasClean.run({ branch, piece });
};

/** The pieces holding `mark` that read a document `piece` writes. */
const readersOf = (
  context: Context,
  piece: string,
  mark: CurrencyMark,
): string[] =>
  (context.statements.selectReadersOfPiece.all({
    branch: context.branch,
    space: context.space,
    piece,
    mark,
  }) as Array<{ piece: string }>).map((row) => row.piece);

/** The marked pieces that write a document `piece` read. */
const markedProducersOf = (context: Context, piece: string): string[] =>
  (context.statements.selectMarkedProducers.all({
    branch: context.branch,
    space: context.space,
    piece,
  }) as Array<{ piece: string }>).map((row) => row.piece);

/**
 * Whether `piece` read a derived document no recorded piece writes: an input
 * whose producer the index knows nothing about.
 */
const hasUnrecordedInput = (context: Context, piece: string): boolean =>
  context.statements.selectUnrecordedInput.get({
    branch: context.branch,
    space: context.space,
    piece,
  }) !== undefined;

/** Whether an input of `piece` is one the index cannot call current. */
const hasStaleInput = (context: Context, piece: string): boolean =>
  markedProducersOf(context, piece).length > 0 ||
  hasUnrecordedInput(context, piece);

/** The pieces that enclose `piece`. */
const underOf = (context: Context, piece: string): string[] =>
  (context.statements.selectUnder.all({
    branch: context.branch,
    piece,
  }) as Array<{ root: string }>).map((row) => row.root);

/**
 * Marks `1` every clean piece downstream of the pieces in `from`, each of
 * which has just become marked: the readers of what they write, the readers
 * of what those write, and so on. A piece that was marked before this walk
 * is where it stops. `seqs` gains each piece marked, at the lowest seq of a
 * piece that marks it, and a piece `seqs` already holds at a higher seq is
 * lowered to it.
 */
const markDownstream = (
  context: Context,
  from: readonly string[],
  seqs: Map<string, number>,
): void => {
  // Lowest seq first, so the first seq a piece is given is the lowest one
  // that reaches it through pieces this walk marks.
  const sources = [...from].sort((a, b) =>
    (seqs.get(a) ?? Infinity) - (seqs.get(b) ?? Infinity)
  );
  for (const source of sources) {
    const queue = [source];
    while (queue.length > 0) {
      const piece = queue.pop()!;
      const seq = seqs.get(piece);
      const readers = context.statements.selectAllReadersOfPiece.all({
        branch: context.branch,
        space: context.space,
        piece,
      }) as Array<{ piece: string; mark: CurrencyMark }>;
      for (const reader of readers) {
        if (reader.mark === 0) {
          setMark(context, reader.piece, 1);
          if (seq !== undefined) seqs.set(reader.piece, seq);
          queue.push(reader.piece);
          continue;
        }
        // A piece this advance marked at a later seq is stale from the
        // earlier one, and so is what reads it.
        const known = seqs.get(reader.piece);
        if (seq !== undefined && known !== undefined && seq < known) {
          seqs.set(reader.piece, seq);
          queue.push(reader.piece);
        }
      }
    }
  }
};

/**
 * Clears every piece marked `1` downstream of the pieces in `from`, each of
 * which has just become clean, that is left with no stale input. A piece
 * marked `2` is where the walk stops.
 */
const clearDownstream = (context: Context, from: readonly string[]): void => {
  const queue = [...from];
  while (queue.length > 0) {
    const piece = queue.pop()!;
    for (const reader of readersOf(context, piece, 1)) {
      if (hasStaleInput(context, reader)) continue;
      setMark(context, reader, 0);
      queue.push(reader);
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
  const pieces =
    (statements.countPieces.get({ branch }) as { count: number }).count;
  // With no piece recorded there is nothing to mark, whatever the store holds
  // above the cursor, so the cursor moves without reading a revision.
  if (cursor === undefined || pieces === 0) {
    if (cursor !== head) statements.upsertCursor.run({ branch, seq: head });
    return [];
  }
  if (cursor >= head) return [];
  const seqs = new Map<string, number>();
  const becameMarked: string[] = [];
  const changes = statements.selectChangedSince.all({
    branch,
    seq: cursor,
  }) as Array<{ id: string; lowest: number; highest: number }>;
  for (const { id, lowest, highest } of changes) {
    const behind = [
      ...statements.selectReadersBehind.all({
        branch,
        space,
        id,
        seq: highest,
      }) as Array<{ piece: string; seq: number }>,
      ...statements.selectWritersBehind.all({
        branch,
        id,
        seq: highest,
      }) as Array<{ piece: string; seq: number }>,
    ];
    for (const row of behind) {
      // The first revision above the row is at `lowest` when the row is
      // below every revision read here, and somewhere above the row's own
      // seq otherwise.
      const seq = Math.max(row.seq + 1, lowest);
      const known = seqs.get(row.piece);
      if (known === undefined || seq < known) seqs.set(row.piece, seq);
      const mark = markOf(context, row.piece);
      if (mark === 2) continue;
      setMark(context, row.piece, 2);
      if (mark === 0) becameMarked.push(row.piece);
    }
  }
  markDownstream(context, becameMarked, seqs);
  statements.upsertCursor.run({ branch, seq: head });
  return [...seqs].map(([piece, seq]) => ({
    piece,
    seq,
    under: underOf(context, piece),
  }));
};

/** The context for `engine`, whose store is `space`'s. */
const contextFor = (engine: Engine, space: string): Context => ({
  engine,
  branch: DEFAULT_BRANCH,
  space,
  statements: statementsFor(engine),
});

/**
 * Brings the marks up to the store's head: every piece with a row behind a
 * revision above the cursor is marked `2`, and every clean piece downstream
 * of one that became marked is marked `1`.
 *
 * @returns The pieces whose rows a revision was found ahead of, and the
 * pieces marked downstream of them.
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
 * Stores `batch`, replacing the rows of each piece it names as a set, after
 * bringing the marks up to the store's head.
 *
 * A row takes the seq its document's head stands at when every revision
 * above `batch.asOf` is one `batch.seen` names, and `batch.asOf` otherwise,
 * so a commit the recording loop had not seen leaves the piece marked `2`.
 * A write row does not move up to a head that a commit other than a
 * derivation put there: the piece did not write what the store holds, so it
 * stays marked until it does. A piece with every row current is `1` while an
 * input of it is stale and `0` otherwise, and a piece that became clean
 * clears the pieces marked `1` downstream of it that are left with no stale
 * input.
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

  /** The highest head seq among the instances of `id`, `0` for none. */
  const heads = new Map<string, number>();
  const headOf = (id: string): number => {
    let head = heads.get(id);
    if (head === undefined) {
      head = (statements.selectHighestHead.get({ branch, id }) as
        | { seq: number | null }
        | undefined)?.seq ?? 0;
      heads.set(id, head);
    }
    return head;
  };

  /** The seqs of the revisions of `id` above `seq`. */
  const revisionsAbove = (id: string, seq: number): number[] =>
    headOf(id) <= seq
      ? []
      : (statements.selectRevisionSeqsAbove.all({ branch, id, seq }) as Array<
        { seq: number }
      >).map((row) => row.seq);

  /** Whether the commit at `seq` is a serving loop's derivation. */
  const isDerivation = (seq: number): boolean =>
    seen.has(seq) ||
    (statements.selectCommitClass.get({ seq }) as
        | { class: string }
        | undefined)?.class === "derived";

  /**
   * The seq a row for `id` takes, and whether a commit the batch had not
   * seen leaves it behind.
   */
  const standing = new Map<string, { seq: number; unseen: boolean }>();
  const standingOf = (id: string): { seq: number; unseen: boolean } => {
    let known = standing.get(id);
    if (known !== undefined) return known;
    const unseen = revisionsAbove(id, batch.asOf).some((seq) => !seen.has(seq));
    known = unseen
      ? { seq: batch.asOf, unseen: true }
      : { seq: headOf(id), unseen: false };
    standing.set(id, known);
    return known;
  };

  /**
   * Whether `piece`, clean since its last record, wrote an instance it
   * vouched for again with nothing it read having changed. Read before its
   * rows are replaced.
   */
  const wroteAgainUnprompted = (piece: string): boolean => {
    const writes = new Map(
      (statements.selectWrites.all({ branch, piece }) as Array<
        { id: string; owned: number; seq: number }
      >).filter((row) => row.owned === 0).map((row) => [row.id, row.seq]),
    );
    // A revision that is no derivation is a change from outside, and
    // whatever the piece wrote after it was prompted.
    for (const [id, seq] of writes) {
      if (revisionsAbove(id, seq).some((above) => !isDerivation(above))) {
        return false;
      }
    }
    const reads = statements.selectReads.all({ branch, piece }) as Array<
      { entity_space: string; entity: string; seq: number }
    >;
    for (const row of reads) {
      if (row.entity_space !== batch.space || writes.has(row.entity)) continue;
      if (headOf(row.entity) > row.seq) return false;
    }
    const vouches = statements.selectVouches.all({ branch, piece }) as Array<
      { id: string; scope_key: string }
    >;
    return vouches.some(({ id, scope_key }) =>
      instanceHeadOf(id, scope_key) > (writes.get(id) ?? 0)
    );
  };

  /** The head seq of the instance `(id, scopeKey)`, `0` for none. */
  const instanceHeadOf = (id: string, scopeKey: string): number =>
    (statements.selectInstanceHead.get({ branch, id, scope_key: scopeKey }) as
      | { seq: number }
      | undefined)?.seq ?? 0;

  engine.database.transaction(() => {
    const wasClean = batch.records
      .map((record) => record.piece)
      .filter((piece) =>
        (statements.selectWasClean.get({ branch, piece }) as
          | { was_clean: number }
          | undefined)?.was_clean === 1
      );
    result.marked = advance(context);
    result.falseClean = wasClean.filter(wroteAgainUnprompted);

    for (const record of batch.records) {
      const { piece } = record;
      const lastWrites = new Map(
        (statements.selectWrites.all({ branch, piece }) as Array<
          { id: string; owned: number; seq: number }
        >).filter((row) => row.owned === 0).map((row) => [row.id, row.seq]),
      );
      statements.deleteUnder.run({ branch, piece });
      statements.deleteReads.run({ branch, piece });
      statements.deleteWrites.run({ branch, piece });
      statements.deleteVouches.run({ branch, piece });
      let unseen = false;
      let overwritten = false;
      for (const root of record.under) {
        if (root !== piece) statements.insertUnder.run({ branch, piece, root });
      }
      // The piece's own result document is an input of it: its pattern
      // pointer decides what the piece computes.
      const reads: CurrencyRead[] = [
        { space: batch.space, id: piece, derived: false },
        ...record.reads,
      ];
      // Nothing marks a piece for a change in another space, so a record
      // that read one is not vouched for, whatever it says.
      let foreign = false;
      for (const read of reads) {
        const local = read.space === batch.space;
        const at = local ? standingOf(read.id) : { seq: 0, unseen: false };
        unseen ||= at.unseen;
        foreign ||= !local;
        statements.insertRead.run({
          branch,
          piece,
          entity_space: read.space,
          entity: read.id,
          derived: read.derived ? 1 : 0,
          seq: at.seq,
        });
      }
      for (const id of record.writes) {
        const at = standingOf(id);
        unseen ||= at.unseen;
        const last = lastWrites.get(id);
        // A head above the last record's that no derivation put there is an
        // overwrite from outside, which the piece's writer did not answer:
        // it reads nothing it writes, so the change did not wake it.
        const foreign = !at.unseen && last !== undefined && at.seq > last &&
          !isDerivation(at.seq);
        overwritten ||= foreign;
        statements.insertWrite.run({
          branch,
          piece,
          id,
          owned: 0,
          seq: foreign ? last : at.seq,
        });
      }
      for (const id of record.owned) {
        statements.insertWrite.run({ branch, piece, id, owned: 1, seq: 0 });
      }
      for (const { id, scopeKey } of record.vouches) {
        // An instance can be overwritten below the head of another instance
        // of its document, which the row for the document does not show.
        const last = lastWrites.get(id);
        const head = instanceHeadOf(id, scopeKey);
        if (
          last !== undefined && head > last && head <= batch.asOf &&
          !isDerivation(head)
        ) {
          overwritten = true;
        }
        statements.insertVouch.run({ branch, piece, id, scope_key: scopeKey });
      }
      const vouched = record.vouched && !foreign;
      if (vouched && unseen && !overwritten) result.behind.push(piece);
      statements.upsertPiece.run({
        branch,
        piece,
        mark: vouched && !unseen && !overwritten ? 0 : 2,
        epoch: batch.epoch,
      });
    }

    // A piece of the batch can read what another piece of it writes, and so
    // can a piece an earlier batch of the same point stored, so the `1`
    // marks among them are settled together: every such piece is taken as
    // clean, and one with an input that is stale even so is dropped, until
    // none is.
    const pieces = batch.records.map((record) => record.piece);
    const settling = new Set(
      (batch.settle ?? []).filter((piece) => markOf(context, piece) === 1),
    );
    const assumed = new Set([
      ...pieces.filter((piece) => markOf(context, piece) === 0),
      ...settling,
    ]);
    for (let changed = true; changed;) {
      changed = false;
      for (const piece of assumed) {
        const stale = hasUnrecordedInput(context, piece) ||
          markedProducersOf(context, piece).some((producer) =>
            !assumed.has(producer)
          );
        if (!stale) continue;
        assumed.delete(piece);
        // A dropped piece is a marked producer from here on.
        if (!settling.has(piece)) setMark(context, piece, 1);
        changed = true;
      }
    }
    const settled = [...settling].filter((piece) => assumed.has(piece));
    for (const piece of settled) {
      setMark(context, piece, 0);
      statements.setWasClean.run({ branch, piece });
    }
    const blockedBy = new Set<string>();
    const marked: string[] = [];
    const clean: string[] = [];
    for (const piece of pieces) {
      const mark = markOf(context, piece);
      if (mark === 0) {
        statements.setWasClean.run({ branch, piece });
        clean.push(piece);
        continue;
      }
      marked.push(piece);
      if (mark === 1) {
        result.blocked.push(piece);
        for (const producer of markedProducersOf(context, piece)) {
          if (!pieces.includes(producer)) blockedBy.add(producer);
        }
      }
    }
    // A record can name writes its piece's last one did not, so a marked
    // piece marks its readers whether or not it was marked before.
    markDownstream(context, marked, new Map());
    clearDownstream(context, [...clean, ...settled]);
    result.blockedBy = [...blockedBy];
  }).immediate();
  return result;
};

/** Why a root is not one the store can serve. */
export type CurrencyRefusal =
  /** The root's piece has no record. */
  | "no-record"
  /** The root's piece is marked. */
  | "marked"
  /** The root's piece was recorded under another epoch. */
  | "other-epoch"
  /** A session demands an instance the piece writes and does not vouch for. */
  | "unvouched-instance"
  /** A session demands an instance of an owned cell the store does not hold. */
  | "absent-owned"
  /** A piece that owns a demanded instance is marked or of another epoch. */
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
 * A root passes when its piece has a clean record of `epoch`, and every
 * demanded instance whose id the piece writes or owns, or a recorded piece
 * beneath it does, has a clean owner of `epoch` that vouches for it: a vouch
 * row for a written id, and a live document in the store for an owned one.
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
    const row = statements.selectPiece.get({ branch, piece: root }) as
      | CurrencyPieceRow
      | undefined;
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

  /** The pieces that own a demanded instance they do not vouch for. */
  const failing = new Map<string, CurrencyRefusal>();
  const judged = new Set<string>();
  for (const { id, scopeKey } of options.rows) {
    const key = `${scopeKey}\0${id}`;
    if (judged.has(key)) continue;
    judged.add(key);
    const owners = statements.selectOwners.all({ branch, id }) as Array<
      { piece: string; owned: number; mark: CurrencyMark; epoch: string }
    >;
    for (const owner of owners) {
      if (failing.has(owner.piece)) continue;
      if (owner.mark !== 0 || owner.epoch !== options.epoch) {
        failing.set(owner.piece, "owner-not-clean");
      } else if (owner.owned !== 0) {
        if (!isLive(context, id, scopeKey)) {
          failing.set(owner.piece, "absent-owned");
        }
      } else if (
        statements.selectVouch.get({
          branch,
          piece: owner.piece,
          id,
          scope_key: scopeKey,
        }) === undefined
      ) {
        failing.set(owner.piece, "unvouched-instance");
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

/** The row the index holds for `piece`, or `undefined` when it holds none. */
export const selectCurrencyPiece = (
  engine: Engine,
  options: { piece: string },
): CurrencyPieceRow | undefined =>
  engine.prepare(`
SELECT mark, epoch FROM currency_piece
WHERE branch = :branch AND piece = :piece
`).get({ branch: DEFAULT_BRANCH, piece: options.piece }) as
    | CurrencyPieceRow
    | undefined;
