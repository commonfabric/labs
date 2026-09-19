// A small LRU pool of read-only SQLite connections keyed by canonical file
// path.
//
// Reads (injected on-disk sources, and — once routed — cell-derived dbs) run
// here: each connection is opened `readonly` directly on the db file and is
// NEVER attached to the per-space engine connection. This gives three things the
// attach-per-op read path could not:
//   - no ATTACH/DETACH churn on the shared single-threaded engine connection;
//   - real per-connection read-only (SQLITE_OPEN_READONLY), not a connection-
//     global `PRAGMA query_only` window;
//   - no namespace collision — each connection's file is its own `main`, so
//     unqualified names resolve to it and there is no core store to shadow.
//
// The statement guard still applies (via `runQuery`): SELECT-only, no
// ATTACH/PRAGMA/multi-statement, so a read can't use its connection to reach
// other files.
//
// Every connection opens with `int64`, so an INTEGER arrives as the integer the
// row holds. `@db/sqlite` otherwise reads an INTEGER column through the 32-bit
// `sqlite3_column_int`, and hands over the low 32 bits of anything wider: a
// stored 4294967303 arrives as 7, and an epoch-millisecond timestamp as a
// negative number. Under `int64` a value within ±(2^53 - 1) arrives as a
// `number`, and one beyond it as a `bigint`, which a double cannot name and a
// `FabricValue` can. A per-row label is derived from these values, so a
// labeled read depends on them being whole; so does any consumer that sorts or
// compares a timestamp.
//
// Every connection also opens with `parseJson: false`, so TEXT arrives as the
// text SQLite holds. `@db/sqlite` otherwise parses a TEXT column that carries
// SQLite's JSON subtype into a JS object or array. The JSON functions attach
// that subtype to what they return (`json_object`, `json_group_array`,
// `json()`, `->`, `json_extract` of a container path), and it belongs to the
// query plan rather than to the statement: a sorter, a materialized subquery,
// and a CTE each drop it. One statement would hand its consumer a string under
// one plan and an object under another, and a consumer whose `Row` type says
// `string` never runs on the object. A query's `Row` type is what decodes a
// column, as it does for a `_cf_link`, so a JSON function's text reaches it as
// text under every plan.

import { Database } from "@db/sqlite";
import type { SqliteNativeRow } from "../../v2.ts";
import {
  type QueryColumn,
  runQuery,
  runQueryWithOrigins,
  type SqliteParams,
} from "./exec.ts";

export class ReadConnectionPool {
  #byPath = new Map<string, Database>();
  readonly #max: number;

  constructor(max = 32) {
    this.#max = max;
  }

  /**
   * Returns the pooled connection for `path`, opening one on a miss and
   * evicting the oldest past `#max`.
   */
  #connection(path: string): Database {
    const existing = this.#byPath.get(path);
    if (existing) {
      // LRU bump: re-insert so this path is most-recently-used.
      this.#byPath.delete(path);
      this.#byPath.set(path, existing);
      return existing;
    }
    const db = new Database(path, {
      readonly: true,
      int64: true,
      parseJson: false,
    });
    // Match the engine connection's busy_timeout (engine.ts PRAGMAS). A pooled
    // read uses a SEPARATE OS connection from the writer's engine connection, so
    // a read that races a writer holding the file lock (another process over the
    // same store, or an external writer to a `cf link`ed disk source) would hit
    // an immediate SQLITE_BUSY at the default timeout of 0 — wait instead.
    db.exec("PRAGMA busy_timeout = 5000");
    this.#byPath.set(path, db);
    if (this.#byPath.size > this.#max) {
      const oldest = this.#byPath.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        const victim = this.#byPath.get(oldest);
        this.#byPath.delete(oldest);
        try {
          victim?.close();
        } catch { /* best-effort */ }
      }
    }
    return db;
  }

  /** Run a guarded read-only SELECT on the pooled read-only connection for
   *  `path`. Throws if the file can't be opened read-only (missing/unreadable). */
  query<Row extends SqliteNativeRow = SqliteNativeRow>(
    path: string,
    sql: string,
    params?: SqliteParams,
  ): Row[] {
    return runQuery<Row>(this.#connection(path), sql, params);
  }

  /**
   * Like {@link query} but also returns each result column's TRUE origin
   * `(table, column)`, for CFC read-labeling. Used only when the db declares
   * per-column `ifc` or a row rule.
   */
  queryWithOrigins<Row extends SqliteNativeRow = SqliteNativeRow>(
    path: string,
    sql: string,
    params?: SqliteParams,
  ): { rows: Row[]; columns: QueryColumn[] } {
    return runQueryWithOrigins<Row>(this.#connection(path), sql, params);
  }

  close(): void {
    for (const db of this.#byPath.values()) {
      try {
        db.close();
      } catch { /* best-effort */ }
    }
    this.#byPath.clear();
  }
}
