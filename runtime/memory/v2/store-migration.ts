// The conversion of a store's rows from text form to the compact form
// (value-store.ts, commit-record.ts), run beside a live engine. The engine
// writes every new row compact and reads both forms, so a store is usable at
// every instant of the run; what this module adds is the conversion of the
// rows written before, the `scheduler_basis` retention setting, and the
// `VACUUM` that gives the freed pages back.
//
// Every batch is one IMMEDIATE transaction holding its row updates, the
// objects, dictionary rows and chunks they insert, and the phase's new cursor
// in `mem_store_migration`. A crash at any instant leaves the last committed
// cursor, and the next run resumes from it. Cursors are primary keys, which
// `VACUUM` never renumbers, not rowids, which it may.

import type { BindValue, Database } from "@db/sqlite";
import { yieldToEventLoop } from "@commonfabric/async/sleep";
import {
  createInvocationRefIndex,
  dropFullInvocationRefIndex,
  type Engine,
  STORE_MIGRATION_PHASES,
} from "./engine.ts";
import { ValueStore } from "./value-store.ts";
import {
  commitDigest,
  CommitRecords,
  encodeResolution,
  resolutionText,
  type StoredCommitCells,
} from "./commit-record.ts";
import { readAclHeads } from "./acl-heads.ts";
import { replaceSchedulerBasisRows } from "./scheduler-basis.ts";

/** What the `basis` phase does with `scheduler_basis` rows. */
export type SchedulerBasisMode = "keep" | "stale" | "all";

/** One phase of the run, in the order the run takes them. */
export type StoreMigrationPhase = typeof STORE_MIGRATION_PHASES[number];

/** Settings of a run. */
export type StoreMigrationOptions = {
  /**
   * `keep` leaves the rows; `stale` deletes the instances the activation
   * scan would report stale from this store; `all` deletes every instance
   * the phase visits. Default `stale`.
   */
  schedulerBasis?: SchedulerBasisMode;

  /**
   * The space DID whose basis rows are home rows. Default: the DID of the
   * store's one ACL document; without exactly one, the phase keeps every row.
   */
  space?: string;

  /** `off` marks the `vacuum` phase done without vacuuming. Default `auto`. */
  vacuum?: "auto" | "off";

  /** Rows (instances for `basis`) per batch. Default per phase. */
  batchRows?: number;

  /**
   * Text bytes per batch for `values`, `snapshots` and `commits`; a row
   * larger than this is a batch of its own. Default 256 KiB.
   */
  batchBytes?: number;

  /**
   * Milliseconds after which a batch takes no further row (instance for
   * `basis`): it ends with the row in hand, and the next batch resumes after
   * it. Every batch takes at least one. Default 50.
   */
  batchMs?: number;

  /** Slots of the run's seen table (value-store.ts). Default 4,194,304. */
  seenSlots?: number;
};

/** One phase as `mem_store_migration` records it. */
export type StoreMigrationPhaseStatus = {
  phase: StoreMigrationPhase;
  state: "pending" | "done" | "failed";

  /** JSON of the last key processed; `null` before the first batch. */
  cursor: string | null;

  /** Rows written in the compact form. */
  converted: number;

  /** Rows left in text form: small values, rows that do not round-trip. */
  kept: number;

  /** Basis rows deleted. */
  deleted: number;

  /** Why the phase failed. */
  error?: string;

  /** Every counter the phase records, the three above included. */
  detail: Record<string, unknown>;
};

/** Every phase, and whether all of them are done. */
export type StoreMigrationStatus = {
  complete: boolean;
  phases: StoreMigrationPhaseStatus[];
};

/** A run in the background. */
export type StoreMigrationHandle = {
  /** Settles when the run completes, fails, or is stopped; never rejects. */
  readonly done: Promise<StoreMigrationStatus>;

  /** Stops after the batch in progress; resolves when no batch runs. */
  stop(): Promise<void>;
};

const DEFAULT_SEEN_SLOTS = 4_194_304;
const DEFAULT_ENTITY_CACHE_MAX = 2_097_152;
const DEFAULT_BATCH_ROWS: Record<StoreMigrationPhase, number> = {
  basis: 50,
  values: 100,
  snapshots: 100,
  commits: 200,
  vacuum: 1,
};
const DEFAULT_BATCH_BYTES = 256 * 1024;
const DEFAULT_BATCH_MS = 50;

/** The most bytes an integer cell takes in a record. */
const INTEGER_CELL_BYTES = 8;

/** Reclaimable bytes below which `VACUUM` is not worth blocking the process for. */
const VACUUM_MIN_FREE_BYTES = 64 * 1024 * 1024;
/** The share of the file that must be reclaimable, as a divisor of its size. */
const VACUUM_MIN_FREE_DIVISOR = 4;

/** The row a converted cell must read back as did not. */
class StoreMigrationMismatch extends Error {
  override name = "StoreMigrationMismatch";
}

/**
 * The run's own value and commit stores on the engine's connection, staged
 * per batch, plus a second pair never staged: inside a transaction it caches
 * nothing, so each check of a converted row reads what SQLite holds.
 */
type Context = {
  values: ValueStore;
  commits: CommitRecords;
  checkValues: ValueStore;
  checkCommits: CommitRecords;
};

const contexts = new WeakMap<Engine, Context>();

const contextOf = (engine: Engine, options: StoreMigrationOptions): Context => {
  let context = contexts.get(engine);
  if (context === undefined) {
    const database = engine.database;
    const values = new ValueStore(database, {
      seenSlots: options.seenSlots ?? DEFAULT_SEEN_SLOTS,
    });
    const checkValues = new ValueStore(database, { seenSlots: 1 });
    context = {
      values,
      commits: new CommitRecords(database, values, {
        entityCacheMax: DEFAULT_ENTITY_CACHE_MAX,
      }),
      checkValues,
      checkCommits: new CommitRecords(database, checkValues),
    };
    contexts.set(engine, context);
  }
  return context;
};

/** Finalizes the run's stores, which frees the seen table. */
const releaseContext = (engine: Engine): void => {
  const context = contexts.get(engine);
  if (context === undefined) return;
  contexts.delete(engine);
  if (engine.closed) return;
  context.commits.close();
  context.values.close();
  context.checkCommits.close();
  context.checkValues.close();
};

type PhaseRow = {
  phase: StoreMigrationPhase;
  state: "pending" | "done" | "failed";
  cursor: string | null;
  detail: string | null;
};

// Every phase in run order. The engine's open inserts all five rows, so a
// phase without one has nothing to do and reads as `done`.
const readPhaseRows = (database: Database): PhaseRow[] => {
  const rows = database.prepare(
    `SELECT phase, state, cursor, detail FROM mem_store_migration`,
  ).all<PhaseRow>();
  const byPhase = new Map(rows.map((row) => [row.phase, row]));
  return STORE_MIGRATION_PHASES.map((phase) =>
    byPhase.get(phase) ??
      { phase, state: "done" as const, cursor: null, detail: null }
  );
};

const statusOfRow = (row: PhaseRow): StoreMigrationPhaseStatus => {
  const detail = row.detail === null
    ? {}
    : JSON.parse(row.detail) as Record<string, unknown>;
  const count = (name: string): number =>
    typeof detail[name] === "number" ? detail[name] as number : 0;
  return {
    phase: row.phase,
    state: row.state,
    cursor: row.cursor,
    converted: count("converted"),
    kept: count("kept"),
    deleted: count("deleted"),
    ...(typeof detail.error === "string" ? { error: detail.error } : {}),
    detail,
  };
};

/** Every phase's state, cursor and counters, as `mem_store_migration` holds them. */
export function readStoreMigrationStatus(engine: Engine): StoreMigrationStatus {
  const phases = readPhaseRows(engine.database).map(statusOfRow);
  return {
    complete: phases.every((phase) => phase.state === "done"),
    phases,
  };
}

/** What a batch did, folded into the phase's counters. */
type BatchResult = {
  /** The cursor to store; `undefined` keeps the stored one. */
  cursor?: unknown;
  done: boolean;
  counters: Record<string, number>;
  /** Fields of the phase's detail that are set rather than added. */
  notes?: Record<string, unknown>;
};

const writePhase = (
  database: Database,
  row: PhaseRow,
  result: BatchResult,
  elapsedMs: number,
): void => {
  const detail = row.detail === null
    ? {}
    : JSON.parse(row.detail) as Record<string, unknown>;
  for (const [name, value] of Object.entries(result.counters)) {
    detail[name] =
      (typeof detail[name] === "number" ? detail[name] as number : 0) +
      value;
  }
  detail.batches = (typeof detail.batches === "number" ? detail.batches : 0) +
    1;
  detail.ms = (typeof detail.ms === "number" ? detail.ms : 0) + elapsedMs;
  detail.maxBatchMs = Math.max(
    typeof detail.maxBatchMs === "number" ? detail.maxBatchMs : 0,
    elapsedMs,
  );
  Object.assign(detail, result.notes ?? {});
  delete detail.error;
  database.prepare(
    `UPDATE mem_store_migration SET state = ?, cursor = ?, detail = ?
     WHERE phase = ?`,
  ).run(
    result.done ? "done" : "pending",
    result.cursor === undefined ? row.cursor : JSON.stringify(result.cursor),
    JSON.stringify(detail),
    row.phase,
  );
};

const markFailed = (database: Database, row: PhaseRow, error: unknown) => {
  const detail = row.detail === null
    ? {}
    : JSON.parse(row.detail) as Record<string, unknown>;
  detail.error = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  database.prepare(
    `UPDATE mem_store_migration SET state = 'failed', detail = ? WHERE phase = ?`,
  ).run(JSON.stringify(detail), row.phase);
};

/**
 * Runs `work` in one IMMEDIATE transaction with the run's stores staged, so
 * that what they cache by id is published only when it commits.
 */
const inBatch = <T>(engine: Engine, context: Context, work: () => T): T => {
  context.values.stage();
  context.commits.stage();
  let committed = false;
  try {
    const result = engine.database.transaction(work).immediate();
    committed = true;
    return result;
  } finally {
    context.commits.settle(committed);
    context.values.settle(committed);
  }
};

/**
 * Starts a batch's clock: the returned function answers whether the batch
 * has spent its `batchMs`.
 */
const batchClock = (options: StoreMigrationOptions): () => boolean => {
  const budget = options.batchMs ?? DEFAULT_BATCH_MS;
  const started = performance.now();
  return () => performance.now() - started >= budget;
};

const utf8Encoder = new TextEncoder();
const textBytes = (text: string): number => utf8Encoder.encode(text).length;

/** The `WHERE` that resumes after `cursor` over `columns`, a primary key. */
const after = (columns: readonly string[], cursor: string | null) =>
  cursor === null ? { where: "", params: [] as BindValue[] } : {
    where: `(${columns.join(", ")}) > (${columns.map(() => "?").join(", ")})`,
    params: JSON.parse(cursor) as BindValue[],
  };

/**
 * Converts the text cells of `table.column` past the cursor, in primary-key
 * order, to the vids of their fragments; a text under the inline limit stays.
 * Each converted cell is read back from SQLite and compared with the text
 * before the row is updated. Rows are read one at a time, each after the one
 * before it, so that a batch reads only the rows it converts.
 */
const convertValues = (
  engine: Engine,
  context: Context,
  row: PhaseRow,
  table: "revision" | "snapshot",
  column: "data" | "value",
  key: readonly string[],
  options: StoreMigrationOptions,
): BatchResult => {
  const spent = batchClock(options);
  const database = engine.database;
  const maxRows = options.batchRows ?? DEFAULT_BATCH_ROWS[row.phase];
  const maxBytes = options.batchBytes ?? DEFAULT_BATCH_BYTES;
  const resume = after(key, row.cursor);
  const select = (where: string) =>
    database.prepare(`
SELECT rowid AS row_id, ${key.join(", ")}, ${column} AS text
FROM ${table}
WHERE typeof(${column}) = 'text'${where ? ` AND ${where}` : ""}
ORDER BY ${key.join(", ")}
LIMIT 1
`);
  type Found = Record<string, unknown> & { row_id: number; text: string };
  const first = select(resume.where);
  const next = select(
    `(${key.join(", ")}) > (${key.map(() => "?").join(", ")})`,
  );
  const update = database.prepare(
    `UPDATE ${table} SET ${column} = ? WHERE rowid = ?`,
  );
  let converted = 0;
  let kept = 0;
  let textBytesConverted = 0;
  let removedBytes = 0;
  let rows = 0;
  let bytes = 0;
  let last: Found | undefined;
  try {
    let found = first.get<Found>(...resume.params);
    while (found !== undefined) {
      last = found;
      const cell = context.values.storeRowText(found.text);
      if (typeof cell === "string") {
        kept++;
      } else {
        if (context.checkValues.rowText(cell) !== found.text) {
          throw new StoreMigrationMismatch(
            `${table} row ${
              JSON.stringify(key.map((name) => last![name]))
            } does not read back as its text from vid ${cell}`,
          );
        }
        update.run(cell, found.row_id);
        converted++;
        const rowBytes = textBytes(found.text);
        textBytesConverted += rowBytes;
        removedBytes += rowBytes - INTEGER_CELL_BYTES;
      }
      rows++;
      bytes += found.text.length;
      if (rows >= maxRows || bytes >= maxBytes || spent()) break;
      found = next.get<Found>(
        ...key.map((name) => last![name] as BindValue),
      );
    }
  } finally {
    first.finalize();
    next.finalize();
    update.finalize();
  }
  if (last === undefined) return { done: true, counters: {} };
  return {
    cursor: key.map((name) => last![name]),
    done: false,
    counters: { converted, kept, textBytesConverted, removedBytes },
  };
};

type CommitCandidate = StoredCommitCells & { resolution: string | Uint8Array };

/**
 * Converts the text `original` and `resolution` cells of the commits past the
 * cursor, in `seq` order. An `original` the encoder keeps as text (commit 1,
 * the compaction tool's commits, a row that does not round-trip) stays; a
 * converted one is read back from SQLite and checked against the text, and an
 * intact commit's digest against the text's. Rows are read one at a time, as
 * `convertValues` reads them.
 */
const convertCommits = (
  engine: Engine,
  context: Context,
  row: PhaseRow,
  options: StoreMigrationOptions,
): BatchResult => {
  const spent = batchClock(options);
  const database = engine.database;
  const maxRows = options.batchRows ?? DEFAULT_BATCH_ROWS.commits;
  const maxBytes = options.batchBytes ?? DEFAULT_BATCH_BYTES;
  const from = row.cursor === null ? 0 : JSON.parse(row.cursor) as number;
  const next = database.prepare(`
SELECT seq, session_id, original, resolution, digest, reads
FROM "commit"
WHERE seq > ?
  AND (typeof(original) = 'text' OR typeof(resolution) = 'text')
ORDER BY seq
LIMIT 1
`);
  const updateOriginal = database.prepare(
    `UPDATE "commit" SET original = ?, digest = ?, reads = ? WHERE seq = ?`,
  );
  const updateResolution = database.prepare(
    `UPDATE "commit" SET resolution = ? WHERE seq = ?`,
  );
  const counters = {
    converted: 0,
    kept: 0,
    hollowed: 0,
    resolutionsConverted: 0,
    resolutionsKept: 0,
    textBytesConverted: 0,
    removedBytes: 0,
  };
  let rows = 0;
  let bytes = 0;
  let last: CommitCandidate | undefined;
  try {
    let found = next.get<CommitCandidate>(from);
    while (found !== undefined) {
      last = found;
      if (typeof found.original === "string") {
        const text = found.original;
        const encoded = context.commits.encode(text, {
          seq: found.seq,
          sessionId: found.session_id,
        });
        if (typeof encoded.original === "string") {
          counters.kept++;
        } else {
          const stored: StoredCommitCells = {
            seq: found.seq,
            session_id: found.session_id,
            original: encoded.original,
            digest: encoded.digest,
            reads: encoded.reads,
          };
          // A marker's text is rebuilt from the digest that carries the
          // hollowed commit's identity, so only an intact commit's digest is
          // the text's.
          const hollowed = context.checkCommits.isHollowed(stored);
          const readBack = context.checkCommits.originalText(stored);
          if (
            readBack !== text ||
            (!hollowed && !sameBytes(encoded.digest, commitDigest(text)))
          ) {
            throw new StoreMigrationMismatch(
              `commit ${found.seq} does not read back as its text`,
            );
          }
          updateOriginal.run(
            encoded.original,
            encoded.digest,
            encoded.reads,
            found.seq,
          );
          counters.converted++;
          if (hollowed) counters.hollowed++;
          const rowBytes = textBytes(text);
          counters.textBytesConverted += rowBytes;
          counters.removedBytes += rowBytes - encoded.original.length -
            (encoded.digest?.length ?? 0) - (encoded.reads?.length ?? 0);
        }
      }
      if (typeof found.resolution === "string") {
        const cell = encodeResolution(found.resolution, found.seq);
        if (typeof cell === "string") {
          counters.resolutionsKept++;
        } else {
          if (resolutionText(cell, found.seq) !== found.resolution) {
            throw new StoreMigrationMismatch(
              `commit ${found.seq}'s resolution does not read back as its text`,
            );
          }
          updateResolution.run(cell, found.seq);
          counters.resolutionsConverted++;
          counters.removedBytes += textBytes(found.resolution) - cell.length;
        }
      }
      rows++;
      if (typeof found.original === "string") bytes += found.original.length;
      if (rows >= maxRows || bytes >= maxBytes || spent()) break;
      found = next.get<CommitCandidate>(found.seq);
    }
  } finally {
    next.finalize();
    updateOriginal.finalize();
    updateResolution.finalize();
  }
  if (last === undefined) return { done: true, counters: {} };
  return {
    cursor: last.seq,
    done: false,
    counters,
  };
};

const sameBytes = (left: Uint8Array | null, right: Uint8Array): boolean =>
  left !== null && left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

/** The space whose basis rows are home rows, or why there is none. */
const homeSpace = (
  database: Database,
  options: StoreMigrationOptions,
): { space: string } | { reason: string } => {
  if (options.space !== undefined) return { space: options.space };
  const heads = readAclHeads(database);
  if (heads.length !== 1) {
    return {
      reason: `the store holds ${heads.length} ACL documents, not one`,
    };
  }
  return { space: heads[0].id.slice("of:".length) };
};

/**
 * Deletes the basis rows of the instances past the cursor that the setting
 * names: under `stale`, each instance with a row in the home space whose
 * recorded seq is behind that document's head on the same branch, the
 * predicate of `selectStaleBasisInstances` judged per instance; under `all`,
 * every instance. The first batch drops `idx_scheduler_basis_entity`, which
 * no statement reads through.
 */
const convertBasis = (
  engine: Engine,
  row: PhaseRow,
  options: StoreMigrationOptions,
): BatchResult => {
  const database = engine.database;
  let mode = options.schedulerBasis ?? "stale";
  const notes: Record<string, unknown> = { mode };
  let space: string | undefined;
  if (mode === "stale") {
    const home = homeSpace(database, options);
    if ("reason" in home) {
      mode = "keep";
      notes.mode = mode;
      notes.reason = `kept every row: ${home.reason}`;
    } else {
      space = home.space;
    }
  }
  if (mode === "keep") return { done: true, counters: {}, notes };
  const spent = batchClock(options);
  if (row.cursor === null) {
    database.exec(`DROP INDEX IF EXISTS idx_scheduler_basis_entity`);
  }
  const key = ["branch", "action", "action_scope_key"];
  const resume = after(key, row.cursor);
  const instances = database.prepare(`
SELECT DISTINCT branch, action, action_scope_key
FROM scheduler_basis
${resume.where ? `WHERE ${resume.where}` : ""}
ORDER BY branch, action, action_scope_key
LIMIT ?
`).all<{ branch: string; action: string; action_scope_key: string }>(
      ...resume.params,
      options.batchRows ?? DEFAULT_BATCH_ROWS.basis,
    );
  if (instances.length === 0) return { done: true, counters: {}, notes };
  const isStale = engine.prepare(`
SELECT EXISTS (
  SELECT 1
  FROM scheduler_basis b
  LEFT JOIN head h
    ON h.branch = b.branch
   AND h.id = b.entity
   AND h.scope_key = b.entity_scope_key
  WHERE b.branch = :branch
    AND b.action = :action
    AND b.action_scope_key = :action_scope_key
    AND b.entity_space = :space
    AND COALESCE(h.seq, 0) > b.seq
) AS stale
`);
  let deleted = 0;
  let instancesDeleted = 0;
  let instancesVisited = 0;
  let last = instances[0];
  for (const instance of instances) {
    last = instance;
    instancesVisited++;
    if (
      mode !== "stale" ||
      (isStale.get({ ...instance, space }) as { stale: number }).stale !== 0
    ) {
      replaceSchedulerBasisRows(engine, {
        branch: instance.branch,
        action: instance.action,
        actionScopeKey: instance.action_scope_key,
        rows: [],
      });
      deleted += database.changes;
      instancesDeleted++;
    }
    if (spent()) break;
  }
  return {
    cursor: [last.branch, last.action, last.action_scope_key],
    done: false,
    counters: { deleted, instancesDeleted, instancesVisited },
    notes,
  };
};

const pragmaNumber = (database: Database, name: string): number =>
  database.prepare(`PRAGMA ${name}`).value<[number]>()![0];

/**
 * Runs `VACUUM` when the reclaimable bytes are at least 64 MiB and a quarter
 * of the file, with temporary storage in a file for its duration: under the
 * engine's `temp_store = MEMORY` the temporary copy of the whole database
 * would be held in memory. Then truncates the write-ahead log. Outside a
 * transaction, since `VACUUM` cannot run inside one. Before it, the full
 * `invocation_ref` index of a store from before the compact form is dropped,
 * and after it, vacuumed or not, the partial one is built, now that the
 * `commit` table is compact.
 *
 * The reclaimable bytes are the larger of the free pages and the bytes the
 * run moved out of rows (`removedBytes` of the earlier phases). A row that
 * shrinks in place frees no page: the space stays inside its now sparse
 * page, which only `VACUUM` gives back, so the free pages alone undercount
 * what a converted table holds unused.
 */
const vacuumPhase = (
  engine: Engine,
  options: StoreMigrationOptions,
  rows: readonly PhaseRow[],
): BatchResult => {
  const database = engine.database;
  dropFullInvocationRefIndex(database);
  const pageSize = pragmaNumber(database, "page_size");
  const pagesBefore = pragmaNumber(database, "page_count");
  const freeBefore = pragmaNumber(database, "freelist_count");
  const removedBytes = rows.map(statusOfRow).reduce(
    (sum, phase) =>
      sum +
      (typeof phase.detail.removedBytes === "number"
        ? phase.detail.removedBytes
        : 0),
    0,
  );
  const reclaimable = Math.max(freeBefore * pageSize, removedBytes);
  const notes: Record<string, unknown> = {
    bytesBefore: pagesBefore * pageSize,
    freeBytesBefore: freeBefore * pageSize,
    removedBytes,
  };
  const worthIt = reclaimable >= VACUUM_MIN_FREE_BYTES &&
    reclaimable * VACUUM_MIN_FREE_DIVISOR >= pagesBefore * pageSize;
  if (options.vacuum === "off" || !worthIt) {
    createInvocationRefIndex(database);
    notes.vacuumed = false;
    return { done: true, counters: {}, notes };
  }
  const tempStore = pragmaNumber(database, "temp_store");
  database.exec(`PRAGMA temp_store = FILE`);
  try {
    database.exec(`VACUUM`);
  } finally {
    database.exec(`PRAGMA temp_store = ${tempStore}`);
  }
  createInvocationRefIndex(database);
  database.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
  notes.vacuumed = true;
  notes.bytesAfter = pragmaNumber(database, "page_count") * pageSize;
  return { done: true, counters: {}, notes };
};

/**
 * Runs one batch of the first phase not yet done, in one IMMEDIATE
 * transaction (the `vacuum` phase outside one), and records its counters and
 * cursor with it. A batch that throws rolls back, and the phase is then
 * marked `failed` with the error; a failed phase is not run again by this
 * function.
 *
 * @returns the phase worked on (`null` once every phase is done) and whether
 *   the run is complete.
 * @throws Error when the engine is closed or a transaction is open on it.
 */
export function runStoreMigrationStep(
  engine: Engine,
  options: StoreMigrationOptions = {},
): { phase: StoreMigrationPhase | null; complete: boolean } {
  if (engine.closed) throw new Error("The engine is closed");
  const database = engine.database;
  if (database.inTransaction) {
    throw new Error(
      "A store migration batch cannot run inside another transaction",
    );
  }
  const row = readPhaseRows(database).find((candidate) =>
    candidate.state !== "done"
  );
  if (row === undefined) {
    releaseContext(engine);
    return { phase: null, complete: true };
  }
  if (row.state === "failed") return { phase: row.phase, complete: false };
  const context = contextOf(engine, options);
  const started = performance.now();
  try {
    if (row.phase === "vacuum") {
      const result = vacuumPhase(engine, options, readPhaseRows(database));
      database.transaction(() =>
        writePhase(database, row, result, performance.now() - started)
      ).immediate();
    } else {
      inBatch(engine, context, () => {
        const result = row.phase === "basis"
          ? convertBasis(engine, row, options)
          : row.phase === "values"
          ? convertValues(
            engine,
            context,
            row,
            "revision",
            "data",
            ["branch", "id", "scope_key", "seq", "op_index"],
            options,
          )
          : row.phase === "snapshots"
          ? convertValues(
            engine,
            context,
            row,
            "snapshot",
            "value",
            ["branch", "id", "scope_key", "seq"],
            options,
          )
          : convertCommits(engine, context, row, options);
        writePhase(database, row, result, performance.now() - started);
      });
    }
  } catch (error) {
    markFailed(database, row, error);
    return { phase: row.phase, complete: false };
  }
  const complete = readPhaseRows(database).every((phase) =>
    phase.state === "done"
  );
  if (complete) releaseContext(engine);
  return { phase: row.phase, complete };
}

/** Marks every failed phase pending again, so a new run retries it once. */
const retryFailedPhases = (engine: Engine): void => {
  engine.database.prepare(
    `UPDATE mem_store_migration SET state = 'pending' WHERE state = 'failed'`,
  ).run();
};

const failureOf = (status: StoreMigrationStatus) =>
  status.phases.find((phase) => phase.state === "failed");

/**
 * Runs batches until every phase is done, synchronously; for tests and
 * offline use. A phase a previous run left failed is tried again.
 *
 * @throws Error naming the phase and its error when a phase fails.
 */
export function runStoreMigrationToCompletion(
  engine: Engine,
  options: StoreMigrationOptions = {},
): StoreMigrationStatus {
  retryFailedPhases(engine);
  for (;;) {
    const step = runStoreMigrationStep(engine, options);
    if (step.complete) break;
    const failed = failureOf(readStoreMigrationStatus(engine));
    if (failed !== undefined) {
      releaseContext(engine);
      throw new Error(
        `The store migration's ${failed.phase} phase failed: ${failed.error}`,
      );
    }
  }
  return readStoreMigrationStatus(engine);
}

/**
 * Runs batches in the background, one per event-loop turn, so requests on the
 * engine interleave between batches. Stops when the run completes, a phase
 * fails, `stop()` is called, or the engine is closed. A phase a previous run
 * left failed is tried again. A store whose run is complete schedules nothing.
 */
export function startStoreMigration(
  engine: Engine,
  options: StoreMigrationOptions = {},
): StoreMigrationHandle {
  let status = readStoreMigrationStatus(engine);
  if (status.complete) {
    const done = Promise.resolve(status);
    return { done, stop: () => Promise.resolve() };
  }
  retryFailedPhases(engine);
  let stopping = false;
  const run = async (): Promise<StoreMigrationStatus> => {
    try {
      for (;;) {
        await yieldToEventLoop();
        if (stopping || engine.closed) break;
        const step = runStoreMigrationStep(engine, options);
        status = readStoreMigrationStatus(engine);
        if (step.complete || failureOf(status) !== undefined) break;
      }
    } catch (error) {
      // The engine closed under the run, or SQLite refused a statement the
      // run does not own the outcome of; the run ends with what it recorded.
      status = {
        ...status,
        phases: status.phases.map((phase) =>
          phase.state === "done" ? phase : {
            ...phase,
            error: error instanceof Error ? error.message : String(error),
          }
        ),
      };
    }
    if (!engine.closed) releaseContext(engine);
    else contexts.delete(engine);
    return status;
  };
  const done = run();
  return {
    done,
    stop: async () => {
      stopping = true;
      await done;
    },
  };
}
