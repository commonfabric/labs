/**
 * Read-only presentation of a compact store in today's form, for the
 * inspector's own SQL: TEMP VIEWs named after the tables whose payload cells
 * may hold a value id or a tagged blob, showing those cells as the text the
 * engine stores today. Temp objects are writable on a read-only connection
 * and take name-resolution precedence over the tables they shadow, so every
 * inspector query reads them unchanged.
 */

import type { Database } from "@db/sqlite";

/** The decoders the views call, built by the caller over the same connection. */
export type CompactViewReaders = {
  /** The row text a `revision.data` or `snapshot.value` cell stands for. */
  valueText(cell: string | number | null): string | null;

  /** The text a `commit` row's `original` cell stands for. */
  commitOriginalText(row: {
    seq: number;
    session_id: string;
    original: string | Uint8Array;
    digest: Uint8Array | null;
    reads: Uint8Array | null;
  }): string;

  /** The text a `commit` row's `resolution` cell stands for. */
  resolutionText(seq: number, resolution: string | Uint8Array): string;
};

/** A payload column a view presents through a function, with that call. */
type PayloadColumn = { table: string; column: string; call: string };

/** The payload columns, by table, and the SQL that presents each as text. */
const PAYLOAD_COLUMNS: readonly PayloadColumn[] = [
  {
    table: "revision",
    column: "data",
    call: sqlText(`mem_value_text("data")`),
  },
  {
    table: "snapshot",
    column: "value",
    call: sqlText(`mem_value_text("value")`),
  },
  {
    table: "commit",
    column: "original",
    call: sqlText(
      `mem_commit_original("seq", "session_id", "original", "digest", "reads")`,
    ),
  },
  {
    table: "commit",
    column: "resolution",
    call: sqlText(`mem_commit_resolution("seq", "resolution")`),
  },
];

/** The tables a view shadows. */
const SHADOWED_TABLES = ["revision", "snapshot", "commit"];

/** Encodes the text a registered function returns. */
const TEXT_ENCODER = new TextEncoder();

/**
 * On `db`, registers SQL functions and creates TEMP VIEWs named `revision`,
 * `snapshot` and `"commit"` that shadow the tables and present `data`,
 * `value`, `original` and `resolution` as today's text, every other column
 * unchanged (the column list read from `pragma_table_info` of `main`). A table
 * `main` lacks gets no view. Installs nothing and returns false when the store
 * has no `mem_value_object` table. Works on a read-only connection.
 *
 * @throws Error when a TEMP object already holds one of the view names.
 */
export function installCompactViews(
  db: Database,
  readers: CompactViewReaders,
): boolean {
  if (!hasMainTable(db, "mem_value_object")) return false;

  const tables = SHADOWED_TABLES.filter((table) => hasMainTable(db, table));
  for (const table of tables) {
    const taken = rowsOf<{ taken: number }>(
      db,
      `SELECT 1 AS taken FROM sqlite_temp_master WHERE name = ?`,
      table,
    );
    if (taken.length > 0) {
      throw new Error(
        `A temporary object named \`${table}\` already shadows the table.`,
      );
    }
  }

  registerFunctions(db, readers);
  for (const table of tables) {
    const columns = rowsOf<{ name: string }>(
      db,
      `SELECT name FROM pragma_table_info(?, 'main') ORDER BY cid`,
      table,
    ).map(({ name }) => name);
    const list = columns.map((column) => {
      const payload = PAYLOAD_COLUMNS.find((entry) =>
        entry.table === table && entry.column === column
      );
      return payload === undefined
        ? quoteIdentifier(column)
        : `${callFor(payload, columns)} AS ${quoteIdentifier(column)}`;
    });
    db.exec(
      `CREATE TEMP VIEW ${quoteIdentifier(table)} AS SELECT ${
        list.join(", ")
      } FROM main.${quoteIdentifier(table)}`,
    );
  }
  return true;
}

/**
 * The form in which a function registered on a connection hands `text` to
 * SQLite: its UTF-8 bytes, which SQLite copies during the call. The binding
 * passes a string result by reference to a buffer that JavaScript may free
 * while SQLite still reads it, so a registered function returns these bytes
 * and its call site reads them as text through {@link sqlText}.
 */
export function textBytes(text: string | null): Uint8Array | null {
  return text === null ? null : TEXT_ENCODER.encode(text);
}

/**
 * The SQL expression that reads `call` as text, where `call` invokes a
 * function returning {@link textBytes}.
 */
export function sqlText(call: string): string {
  return `CAST(${call} AS TEXT)`;
}

/**
 * Helper for `installCompactViews()`, which registers the three deterministic
 * functions the views call. Each copies a blob argument before handing it on,
 * since the argument's bytes belong to SQLite only for the call, and returns
 * its text as {@link textBytes}.
 */
function registerFunctions(db: Database, readers: CompactViewReaders): void {
  const options = { deterministic: true };
  db.function(
    "mem_value_text",
    (cell: string | number | null) => textBytes(readers.valueText(cell)),
    options,
  );
  db.function(
    "mem_commit_original",
    (
      seq: number,
      sessionId: string,
      original: string | Uint8Array,
      digest: Uint8Array | null,
      reads: Uint8Array | null,
    ) =>
      textBytes(
        readers.commitOriginalText({
          seq,
          session_id: sessionId,
          original: copyOf(original),
          digest: copyOf(digest),
          reads: copyOf(reads),
        }),
      ),
    options,
  );
  db.function(
    "mem_commit_resolution",
    (seq: number, resolution: string | Uint8Array) =>
      textBytes(readers.resolutionText(seq, copyOf(resolution))),
    options,
  );
}

/**
 * Helper for `installCompactViews()`, which gives the call for `payload`, with
 * `NULL` in place of an argument column the table lacks.
 */
function callFor(payload: PayloadColumn, columns: readonly string[]): string {
  return payload.call.replace(
    /"([a-z_]+)"/g,
    (whole, name: string) => columns.includes(name) ? whole : "NULL",
  );
}

/** Whether `main` holds a table named `name`. */
function hasMainTable(db: Database, name: string): boolean {
  return rowsOf<{ found: number }>(
    db,
    `SELECT 1 AS found FROM main.sqlite_master WHERE type = 'table' AND name = ?`,
    name,
  ).length > 0;
}

/** Every row `sql` yields for `parameter`, on a statement finalized before returning. */
function rowsOf<T extends object>(
  db: Database,
  sql: string,
  parameter: string,
): T[] {
  const statement = db.prepare(sql);
  try {
    return statement.all<T>(parameter);
  } finally {
    statement.finalize();
  }
}

/** `name` as a quoted SQL identifier. */
function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** A copy of `value` when it is a byte array, else `value` itself. */
function copyOf<T>(value: T): T {
  return (value instanceof Uint8Array ? value.slice() : value) as T;
}
