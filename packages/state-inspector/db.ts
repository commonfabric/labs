// Read-only access to a memory v2 space SQLite file.
//
// Everything here is offline and side-effect free: we open the durable store
// the server already wrote and never mutate it — the durable store is the
// flight recorder (see README.md).

import { type BindValue, Database, type Statement } from "@db/sqlite";

export interface CommitRow {
  seq: number;
  branch: string;
  session_id: string;
  local_seq: number;
  invocation_ref: string | null;
  authorization_ref: string | null;
  original: string;
  resolution: string;
  created_at: string;
}

export interface RevisionRow {
  branch: string;
  id: string;
  scope_key: string;
  seq: number;
  op_index: number;
  op: string;
  data: string | null;
  commit_seq: number;
}

export interface BranchRow {
  name: string;
  parent_branch: string | null;
  fork_seq: number | null;
  created_seq: number;
  head_seq: number;
  status: string;
}

export interface SpaceDb {
  readonly db: Database;
  readonly path: string;

  /**
   * The first row `sql` yields for `params`, or undefined when it yields none.
   *
   * The statement is prepared once per SQL text and reused for the life of the
   * space, which is what a read issued once per entity needs: one prepared per
   * call stays alive until the database closes, a few KB each, and a
   * space-wide walk issues millions. The statement never leaves this object,
   * because one used after it is finalized, or after its database closes,
   * crashes the process rather than throwing — so a read after `close` is
   * refused here with an error instead.
   */
  get<T extends object>(sql: string, ...params: BindValue[]): T | undefined;

  /** Every row `sql` yields for `params`, prepared as {@link get} prepares. */
  all<T extends object>(sql: string, ...params: BindValue[]): T[];

  close(): void;
}

/** Open a space DB read-only. Safe against stale (and, best-effort, live) files. */
export function openSpace(path: string): SpaceDb {
  const db = new Database(path, { readonly: true });
  shimScopeKey(db);
  const statements = new Map<string, Statement>();
  let closed = false;
  const statement = (sql: string): Statement => {
    if (closed) throw new Error(`The space at ${path} is closed.`);
    let stmt = statements.get(sql);
    if (stmt === undefined) statements.set(sql, stmt = db.prepare(sql));
    return stmt;
  };
  return {
    db,
    path,
    get: <T extends object>(sql: string, ...params: BindValue[]) =>
      statement(sql).get<T>(...params),
    all: <T extends object>(sql: string, ...params: BindValue[]) =>
      statement(sql).all<T>(...params),
    close: () => {
      if (closed) return;
      closed = true;
      for (const stmt of statements.values()) stmt.finalize();
      statements.clear();
      db.close();
    },
  };
}

/**
 * Older space DBs predate the per-scope `scope_key` column (added with
 * PerUser/PerSession scopes) on `revision` AND `snapshot`. Every scope-aware
 * query filters `scope_key = …`, so on those DBs we shim the column with a TEMP
 * VIEW that shadows the table and supplies a constant `'space'` scope. Temp
 * objects are writable even on a READONLY main DB and take name-resolution
 * precedence over the real table, so all existing queries work unchanged.
 */
function shimScopeKey(db: Database): void {
  const lacksScopeKey = (table: string): boolean =>
    !db
      .prepare(
        `SELECT 1 FROM pragma_table_info(?) WHERE name = 'scope_key'`,
      )
      .get<{ 1: number }>(table);
  const tableExists = (table: string): boolean =>
    !!db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?",
      )
      .get<{ 1: number }>(table);

  if (lacksScopeKey("revision")) {
    db.exec(
      `CREATE TEMP VIEW revision AS
         SELECT branch, id, 'space' AS scope_key, seq, op_index, op, data, commit_seq
         FROM main.revision`,
    );
  }
  // The snapshot table is optional and, on the same legacy DBs, also lacks
  // scope_key — shim it too so the snapshot-base read doesn't hit a missing
  // column (it would otherwise throw on a pre-scope_key DB that has snapshots).
  if (tableExists("snapshot") && lacksScopeKey("snapshot")) {
    db.exec(
      `CREATE TEMP VIEW snapshot AS
         SELECT branch, id, 'space' AS scope_key, seq, value FROM main.snapshot`,
    );
  }
}

export function tableNames(db: Database): string[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    )
    .all<{ name: string }>()
    .map((r) => r.name);
}

/**
 * The scheduler basis index (serving-loop.md §3b) is the only durable
 * scheduler state besides the watermark machinery. It exists on every
 * migrated store but may be absent on a pre-migration snapshot, so the
 * autopsy core degrades gracefully.
 */
export function hasSchedulerBasisTable(db: Database): boolean {
  return tableNames(db).includes("scheduler_basis");
}
