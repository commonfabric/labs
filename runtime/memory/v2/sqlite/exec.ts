// Engine-side SQLite execution: guarded query/write and additive DDL.
// Runs server-side (this package owns the @db/sqlite Database). Statement safety
// is enforced by the tokenizer-level guard; `_cf_link` encode/decode happens on
// the client (runner) before/after these calls.

import { type BindValue, Database } from "@db/sqlite";
import { fabricFromConvertibleJsValue } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { isPlainObject } from "@commonfabric/utils/types";
import type { SqliteNativeRow } from "../../v2.ts";
import { assertReadOnly, assertWriteSafe } from "./guard.ts";
import { columnOrigins } from "./column-origin.ts";
import { createTableSQL, type TableSchema } from "./schema.ts";

// Reserved schema names that may never be used as a pattern-db attach alias.
const RESERVED_ALIASES = new Set(["main", "temp"]);

/** Derive a safe attach alias from an opaque db id (e.g. an `of:fid1:abc…` entity
 *  id). The `cf_` prefix guarantees a valid leading identifier char. */
export function aliasForDbId(id: string): string {
  return `cf_${id.replace(/[^A-Za-z0-9]/g, "_")}`;
}

/** Validate an attach alias: a plain SQL identifier, not a reserved schema. */
export function assertSafeAlias(alias: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias) || RESERVED_ALIASES.has(alias)) {
    throw new TypeError(`invalid attach alias: ${alias}`);
  }
}

/**
 * ATTACH a cell-derived database file under an internal alias.
 *
 * Must be called OUTSIDE any open transaction — SQLite rejects ATTACH/DETACH
 * while a transaction is active. The commit-folded write path must therefore
 * attach the db *before* `BEGIN`.
 *
 * Caller owns attach/detach pairing: re-attaching an in-use alias throws, and
 * there is a connection-global limit (`SQLITE_MAX_ATTACHED`, default ~10) — an
 * LRU attach/detach cache manages this (spec 08-open-questions Q8a).
 */
export function attachDatabase(
  db: Database,
  alias: string,
  path: string,
): void {
  assertSafeAlias(alias);
  if (db.inTransaction) {
    throw new Error("attachDatabase must be called outside a transaction");
  }
  // Path is bound as a parameter; the alias is a validated literal (it cannot be
  // a bind parameter in ATTACH). Only the cell-derived WRITE path attaches here
  // (read-write, folded into the commit). Reads — cell-derived and injected
  // on-disk — run unattached on the read pool (ReadConnectionPool), which opens
  // each file `readonly`; that is where read-only enforcement now lives.
  db.exec(`ATTACH DATABASE ? AS ${alias}`, path);
}

/** DETACH a previously attached alias. Must be called outside a transaction and
 *  only when the alias is not in use (SQLite throws otherwise). */
export function detachDatabase(db: Database, alias: string): void {
  assertSafeAlias(alias);
  if (db.inTransaction) {
    throw new Error("detachDatabase must be called outside a transaction");
  }
  db.exec(`DETACH DATABASE ${alias}`);
}

export type SqliteParams = readonly unknown[] | Record<string, unknown>;

export type WriteResult = {
  changes: number;
  lastInsertRowid: number;
};

// @db/sqlite binds positional values as a rest list and named values as a single
// record argument. Top-level binary values stay as FabricBytes over the memory
// protocol and become Uint8Array only at this native database edge. Binary
// values nested in JSON structures become byte arrays before SQLite encodes
// the surrounding value.
// (Exported for the commit-time row-label evaluator, which prepares the same
// wire params against its RETURNING-instrumented statement.)
export function bindArgs(params?: SqliteParams): BindValue[] {
  if (params === undefined) return [];
  const bindValue = (value: unknown, nested = false): unknown => {
    if (value instanceof FabricBytes) {
      return nested ? [...value.slice()] : value.slice();
    }
    if (Array.isArray(value)) {
      return value.map((member) => bindValue(member, true));
    }
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, member]) => [
          key,
          bindValue(member, true),
        ]),
      );
    }
    return value;
  };
  return (Array.isArray(params)
    ? params.map((value) => bindValue(value))
    : [Object.fromEntries(
      Object.entries(params).map(([key, value]) => [key, bindValue(value)]),
    )]) as BindValue[];
}

function rowFromNative<Row extends SqliteNativeRow>(
  names: string[],
  values: unknown[],
): Row {
  return Object.fromEntries(
    names.map((key, index) => [
      key,
      fabricFromConvertibleJsValue(values[index]),
    ]),
  ) as Row;
}

/** Run a single guarded read-only SELECT and return all rows. */
export function runQuery<Row extends SqliteNativeRow = SqliteNativeRow>(
  db: Database,
  sql: string,
  params?: SqliteParams,
): Row[] {
  assertReadOnly(sql);
  const stmt = db.prepare(sql);
  try {
    const names = stmt.columnNames();
    return stmt.values<unknown[]>(...bindArgs(params))
      .map((values) => rowFromNative<Row>(names, values));
  } finally {
    stmt.finalize();
  }
}

/** A result column's output name plus its TRUE source `(table, column)` origin
 *  (null for an expression/computed/compound column). */
export type QueryColumn = {
  output: string;
  table: string | null;
  column: string | null;
};

/**
 * Like {@link runQuery}, but also returns each result column's TRUE origin
 * (resolved by the engine via SQLite column-metadata — see `column-origin.ts`),
 * so CFC read-labeling can map an aliased/joined result column back to the
 * declared `(table, column)` it came from, soundly. Only used when the db
 * declares per-column `ifc` (zero overhead otherwise — callers use `runQuery`).
 */
export function runQueryWithOrigins<
  Row extends SqliteNativeRow = SqliteNativeRow,
>(
  db: Database,
  sql: string,
  params?: SqliteParams,
): { rows: Row[]; columns: QueryColumn[] } {
  assertReadOnly(sql);
  const stmt = db.prepare(sql);
  try {
    const names = stmt.columnNames();
    const origins = columnOrigins(stmt.unsafeHandle, names.length);
    const rows = stmt.values<unknown[]>(...bindArgs(params))
      .map((values) => rowFromNative<Row>(names, values));
    return {
      rows,
      columns: names.map((output, i) => ({
        output,
        table: origins[i]?.table ?? null,
        column: origins[i]?.column ?? null,
      })),
    };
  } finally {
    stmt.finalize();
  }
}

/** Run a single guarded INSERT/UPDATE/DELETE. */
export function runWrite(
  db: Database,
  sql: string,
  params?: SqliteParams,
): WriteResult {
  assertWriteSafe(sql);
  const changes = db.prepare(sql).run(...bindArgs(params));
  // `lastInsertRowId` is connection-global; correct here because the engine uses
  // one synchronous connection per space (no interleaving between run and read).
  return { changes, lastInsertRowid: db.lastInsertRowId };
}

/**
 * Additive table reconciliation (Phase 2 V1): create missing tables. Destructive
 * or ambiguous changes to existing tables are out of scope and intentionally not
 * applied here; a future migration step handles them (refuse-by-default + opt-in
 * callback — see spec 08-open-questions Q9).
 */
export function ensureTables(
  db: Database,
  tables: Record<string, TableSchema>,
  alias?: string,
): void {
  if (alias !== undefined) assertSafeAlias(alias);
  for (const [name, schema] of Object.entries(tables)) {
    db.exec(createTableSQL(name, schema, alias));
  }
}
