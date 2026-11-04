// table() / cfLink() schema helpers + additive DDL generation
// (spec docs/specs/sqlite-builtin/01, and Phase 2 create-only migration).
//
// `table(columns)` builds a JSON Schema for one row. Each column carries a
// non-standard `sqlType` annotation used to generate `CREATE TABLE` DDL, and
// `_cf_link` columns carry `cfLink: true` to drive encode/decode (Section 02).
// These helpers compile to plain data; the transformer/runtime do not special-
// case them.

import type {
  FabricValue,
  JSONSchemaTypes,
  SqliteColumnSchema,
  SqliteColumnSpec,
} from "@commonfabric/api";
import { CF_LINK_SUFFIX, isCfLinkColumn } from "./columns.ts";
import { buildRowLabelSpec, type RowLabelRule } from "./row-label.ts";

/**
 * One column of a table as this module stores it: what
 * `@commonfabric/api` declares to a pattern author, with the `sqlType` that
 * `normalizeColumn` supplies for a column declared without one.
 */
export type ColumnSchema = SqliteColumnSchema & { sqlType: string };

export type TableSchema = {
  type: "object";
  properties: Record<string, ColumnSchema>;
  required: string[];
  [key: string]: FabricValue;
};

/** Column spec: a shorthand SQL type string, or an explicit column schema. */
export type ColumnSpec = SqliteColumnSpec;

/** A `_cf_link` column: TEXT in SQLite, a Cell<T> in TypeScript. */
export function cfLink<_T = unknown>(): ColumnSchema {
  return { type: "string", cfLink: true, sqlType: "text" };
}

// Server trust boundary: column names and the verbatim `sqlType` are
// interpolated into CREATE TABLE DDL (createTableSQL), so they MUST be validated
// wherever DDL is generated — not only in the client-side `table()` builder.
// `db.tables` arrives over the wire (untrusted) and reaches createTableSQL via
// ensureTables, so the same checks run there too.
// Per-table column cap for wire-supplied schemas (DoS bound; SQLite's own limit
// is far higher, so this is a policy cap, not the engine limit).
const MAX_TABLE_COLUMNS = 256;
const COLUMN_NAME_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;
// Type keywords, constraints, numbers, parens, commas, quotes, hyphen — notably
// NO ";", so multi-statement DDL injection ("text); DROP TABLE x;--") is rejected.
const SQL_TYPE_RE = /^[A-Za-z0-9_ (),'-]*$/;

/** Validate a column name + verbatim `sqlType` before they are interpolated into
 *  DDL. Throws on anything that could smuggle SQL. Safe to call on untrusted
 *  (wire-supplied) schema; `createTableSQL` calls it for every column. */
export function assertSafeColumn(name: string, sqlType: string): void {
  if (!COLUMN_NAME_RE.test(name)) {
    throw new TypeError(`invalid column name "${name}"`);
  }
  if (!SQL_TYPE_RE.test(sqlType)) {
    throw new TypeError(`invalid sqlType for column "${name}": ${sqlType}`);
  }
}

// Map the leading SQL type word to a JSON Schema `type`.
function jsonTypeForSql(sqlType: string): JSONSchemaTypes {
  const head = sqlType.trim().toLowerCase().split(/\s+/)[0] ?? "";
  switch (head) {
    case "integer":
    case "int":
      return "integer";
    case "real":
    case "float":
    case "double":
    case "numeric":
    case "decimal":
      return "number";
    case "text":
    case "blob":
    case "":
      return "string";
    default:
      return "string";
  }
}

function normalizeColumn(name: string, spec: ColumnSpec): ColumnSchema {
  const col: ColumnSchema = typeof spec === "string"
    ? { type: jsonTypeForSql(spec), sqlType: spec }
    : { ...spec, sqlType: spec.sqlType ?? "text" };

  // Validate identifiers and the verbatim sqlType so a hostile/buggy table
  // declaration can't smuggle DDL (e.g. `text); DROP TABLE x;--`) through
  // createTableSQL's interpolation. (createTableSQL re-checks server-side too.)
  assertSafeColumn(name, col.sqlType);

  const looksLink = col.cfLink === true;
  const namedLink = isCfLinkColumn(name);

  // A cfLink column must be named `*_cf_link`.
  if (looksLink && !namedLink) {
    throw new TypeError(
      `cfLink column "${name}" must end in "${CF_LINK_SUFFIX}"`,
    );
  }
  // A `*_cf_link` column must be a single string/TEXT field.
  if (namedLink) {
    const sqlHead = col.sqlType.trim().toLowerCase().split(/\s+/)[0];
    if (col.type !== "string" || (sqlHead !== "text" && sqlHead !== "")) {
      throw new TypeError(
        `_cf_link column "${name}" must be a string/TEXT field`,
      );
    }
    col.cfLink = true;
  }
  return col;
}

/**
 * Build a one-row JSON Schema from a column map. The optional `rule` declares
 * a per-row CFC label as a pure projection over the row's columns (CFC Phase
 * 3); it is built + validated eagerly — a malformed rule throws here, at
 * definition time — and serializes onto the schema as `rowLabel` (see
 * `row-label.ts` and docs/specs/sqlite-builtin/06-cfc.md).
 *
 * `opts.allowReadClearance` opts the table into CFC Phase 3.b read-time
 * clearance: a `readClearance` query may then filter rows to those the acting
 * reader can read (a declared existence release). It needs a `rowLabel` rule —
 * clearance filters rows by their per-row label — so it throws without one.
 */
export function table<C extends Record<string, ColumnSpec>>(
  columns: C,
  rule?: RowLabelRule<C>,
  opts?: { allowReadClearance?: boolean },
): TableSchema {
  const properties: Record<string, ColumnSchema> = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(columns)) {
    properties[name] = normalizeColumn(name, spec);
    required.push(name);
  }
  const schema: TableSchema = { type: "object", properties, required };
  if (rule !== undefined) {
    schema.rowLabel = buildRowLabelSpec(
      Object.keys(columns),
      rule,
      properties,
    );
  }
  if (opts?.allowReadClearance) {
    if (rule === undefined) {
      throw new Error(
        "table(): allowReadClearance needs a rowLabel rule — read-time " +
          "clearance filters rows by their per-row label",
      );
    }
    schema.rowLabelReadClearance = true;
  }
  return schema;
}

/** Names of the `_cf_link` columns in a table schema. */
export function linkColumnsOf(t: TableSchema): string[] {
  return Object.entries(t.properties)
    .filter(([name, col]) => col.cfLink === true || isCfLinkColumn(name))
    .map(([name]) => name);
}

const quoteIdent = (id: string) => `"${id.replace(/"/g, '""')}"`;

/**
 * Additive DDL for a table (Phase 2: create-only). Column names are quoted and
 * sqlType is validated by `table()` (see normalizeColumn). When `schema` (an
 * attach alias) is given, the table is created in that attached database —
 * required for the per-cell-db ATTACH model, since unqualified `CREATE TABLE`
 * always targets `main` (SQLite has no default-schema switch). The alias must be
 * a validated identifier (see `assertSafeAlias`).
 */
export function createTableSQL(
  name: string,
  t: TableSchema,
  schema?: string,
): string {
  // A table with no columns would emit `CREATE TABLE t ()` — invalid SQL that
  // fails opaquely at the engine. Reject it here (covers both `table({})` and a
  // wire-supplied empty `db.tables` entry).
  const columnCount = t.properties ? Object.keys(t.properties).length : 0;
  if (columnCount === 0) {
    throw new TypeError(`table "${name}" must declare at least one column`);
  }
  // Cap columns per table: `db.tables` is wire-supplied (untrusted), and a
  // multi-thousand-column CREATE TABLE is a DoS vector on the shared engine.
  if (columnCount > MAX_TABLE_COLUMNS) {
    throw new TypeError(
      `table "${name}" has too many columns (${columnCount} > ${MAX_TABLE_COLUMNS})`,
    );
  }
  const cols = Object.entries(t.properties).map(
    ([col, col_schema]) => {
      // Re-validate at the interpolation site: `t` may be wire-supplied
      // `db.tables` that never passed through `table()`/normalizeColumn.
      const sqlType = col_schema.sqlType ?? "text";
      assertSafeColumn(col, sqlType);
      return `  ${quoteIdent(col)} ${sqlType}`;
    },
  );
  const target = schema
    ? `${quoteIdent(schema)}.${quoteIdent(name)}`
    : quoteIdent(name);
  return `CREATE TABLE IF NOT EXISTS ${target} (\n${cols.join(",\n")}\n)`;
}
