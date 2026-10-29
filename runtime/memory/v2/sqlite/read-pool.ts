// A small LRU pool of read-only SQLite connections keyed by canonical file path
// and by integer mode.
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
// Two connections per file, opened in different integer modes, because CFC
// labeling needs whole integers and nothing else may change under it.
// `@db/sqlite` reads an INTEGER column through the 32-bit
// `sqlite3_column_int` unless `int64` is set, so a stored 4294967303 arrives
// as 7 — and a per-row label derived from that gates the row as mailbox 7.
// The labeled reads (`queryWithOrigins`, issued only for a db that declares
// `ifc` or a row rule) therefore run on an `int64` connection, where a value
// past 2^53 arrives as a `bigint` rather than a rounded number. Ordinary
// reads keep the connection and the values they have always had: widening
// them is a change to every consumer's data, which belongs to its own
// change rather than riding in on a labeling fix.
//
// Both modes open with `parseJson: false`, so TEXT arrives as the text SQLite
// holds. `@db/sqlite` otherwise parses a TEXT column that carries SQLite's
// JSON subtype into a JS object or array. The JSON functions attach that
// subtype to what they return (`json_object`, `json_group_array`, `json()`,
// `->`, `json_extract` of a container path), and it belongs to the query plan
// rather than to the statement: a sorter, a materialized subquery, and a CTE
// each drop it. One statement would hand its consumer a string under one plan
// and an object under another, and a consumer whose `Row` type says `string`
// never runs on the object. A query's `Row` type is what decodes a column, as
// it does for a `_cf_link`, so a JSON function's text reaches it as text under
// every plan.

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
   * Returns the pooled connection for `path` in the given mode, opening one
   * on a miss and evicting the oldest past `#max`. Keyed by mode as well as
   * path: the two modes return different JS values for the same stored row,
   * so one connection cannot serve both.
   */
  #connection(path: string, int64: boolean): Database {
    const key = int64 ? `int64\n${path}` : `plain\n${path}`;
    const existing = this.#byPath.get(key);
    if (existing) {
      // LRU bump: re-insert so this path is most-recently-used.
      this.#byPath.delete(key);
      this.#byPath.set(key, existing);
      return existing;
    }
    const db = new Database(path, {
      readonly: true,
      int64,
      parseJson: false,
    });
    // Match the engine connection's busy_timeout (engine.ts PRAGMAS). A pooled
    // read uses a SEPARATE OS connection from the writer's engine connection, so
    // a read that races a writer holding the file lock (another process over the
    // same store, or an external writer to a `cf link`ed disk source) would hit
    // an immediate SQLITE_BUSY at the default timeout of 0 — wait instead.
    db.exec("PRAGMA busy_timeout = 5000");
    this.#byPath.set(key, db);
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
    return runQuery<Row>(this.#connection(path, false), sql, params);
  }

  /**
   * Like {@link query} but also returns each result column's TRUE origin
   * `(table, column)`, for CFC read-labeling. Used only when the db declares
   * per-column `ifc` or a row rule.
   *
   * Runs on the `int64` connection, so a label derived from an INTEGER column
   * is derived from the integer the row holds: see the note at the top of
   * this file for what the other mode does to one. A value past 2^53 arrives
   * as a `bigint`, which is a `FabricValue` the JSON codec carries.
   */
  queryWithOrigins<Row extends SqliteNativeRow = SqliteNativeRow>(
    path: string,
    sql: string,
    params?: SqliteParams,
  ): { rows: Row[]; columns: QueryColumn[] } {
    return runQueryWithOrigins<Row>(this.#connection(path, true), sql, params);
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
