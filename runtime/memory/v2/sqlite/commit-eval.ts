// CFC Phase 3.c — server-side commit-time row-label re-derivation.
//
// A `sqlite` op folded into a commit executes inside `applyCommitTransaction`
// where no pattern code runs, so the per-row label rule (a pure declarative
// projection, `row-label.ts`) is the only thing that CAN check it. When the
// write's target table declares a `rowLabel` rule, this module executes the
// statement, reads the affected rows BACK BY ROWID, and runs the SHARED
// evaluator (`evaluateRowLabel` — the same one the write gate and read
// re-derivation use, so the sides cannot drift) against each TRUE committed
// row. Any rule-evaluation failure throws, rolling back the WHOLE commit
// (cell ops included — `applyCommit` runs in one transaction).
//
// This covers the write shapes the runner gate cannot attribute and previously
// failed closed on (INSERT…SELECT, upsert, columnless INSERT, UPDATE of a
// rule-input column): the committed row is the ground truth, whatever the
// statement's shape. The NO-LAUNDERING half of the write gate stays
// runner-side — the server sees only stored values, never the CFC labels
// carried by the writer's bound inputs, so "every labeled input is captured by
// the row's label" is only checkable where the labels live. The runner relaxes
// its shape rejects solely when the server advertises this evaluation
// (`MemoryProtocolFlags.sqliteCommitRowLabelEval`), and keeps them for labeled
// inputs regardless.
//
// The evaluation runs UNCONDITIONALLY server-side (not gated on the client's
// protocol flags): it is the server's own soundness enforcement, so a stale or
// hostile client cannot skip it by claiming an older protocol.
//
// Affected-row identification appends `RETURNING <rowid> AS __cf_rowid` to the
// statement (SQLite applies ALL of a RETURNING DML's changes on the first
// step; stepping to completion collects the rows) — but the label is evaluated
// against the READ-BACK row, not the RETURNING output, so RETURNING's
// same-statement-double-touch timing caveats cannot skew it. A statement that
// already carries RETURNING fails closed on a rule-bearing table (a second
// clause cannot be appended soundly — and `db.exec` returns void, so the
// clause had no consumer anyway).
//
// Trust note: `op.db.owner` (resolving the rule's `dbOwner()` term) is
// client-supplied, like the rest of the db ref. A forged owner can only turn
// an ABSENT owner into a present one — every structural failure the evaluator
// enforces (strict-if-present, `min` anchors, unique integrity subjects,
// malformed nodes) is owner-independent — and the read side re-resolves the
// owner from the handle cell, never from a writer's claim.

import { Database } from "@db/sqlite";
import { type SqliteOperation, tableDeclaresRowLabel } from "../../v2.ts";
import {
  evaluateRowLabel,
  type RowLabelSpec,
  ruleInputFields,
  validateRowLabelSpec,
} from "./row-label.ts";
import { blankWriteSql, parseWriteTable } from "./write-targets.ts";
import { bindArgs, runWrite, type WriteResult } from "./exec.ts";
import { assertWriteSafe } from "./guard.ts";

/** Policy cap on rows one statement may write into a rule-bearing table: each
 *  affected row runs the rule's regexes on the shared, single-threaded
 *  per-space engine connection, and the runner-side gate's natural bound
 *  (params ride the statement) does not apply to INSERT…SELECT. Exceeding the
 *  cap fails closed (rolls back), like the MAX_SQLITE_TABLES policy cap. */
export const MAX_ROW_LABEL_EVAL_ROWS = 10_000;

// IN-list size for the read-back (well under SQLITE_MAX_VARIABLE_NUMBER).
const READ_BACK_CHUNK = 400;

/** A commit-time row-label violation (or an unattributable/unevaluable write
 *  to a rule-bearing table). Thrown inside `applyCommitTransaction`, so it
 *  rolls back the whole commit; reaches the client as a terminal (non-retry)
 *  transaction error. */
export class RowLabelCommitError extends Error {
  override name = "RowLabelCommitError";

  /**
   * The commit operation that produced the refusal, attached by the engine's
   * operation loop. The evaluator itself sees only one sqlite operation; the
   * engine adds this index before the error crosses the commit boundary so a
   * wave can attribute the proven-no-commit failure to its owning run.
   */
  operationIndex?: number;
}

const fail = (message: string): never => {
  throw new RowLabelCommitError(`sqlite commit refused: ${message}`);
};

const quoteIdent = (id: string) => `"${id.replace(/"/g, '""')}"`;

// Rowids and rule inputs both cross into JS as TEXT, rendered by SQLite —
// see `rowidText` and `renderedInput` below for why. A rowid is therefore a
// string of digits here; anything else means the render did not happen.
const isRowidValue = (v: unknown): v is string =>
  typeof v === "string" && /^-?\d+$/.test(v);

// The engine connection reads an INTEGER column through `sqlite3_column_int`,
// the 32-bit accessor (`@db/sqlite` uses `sqlite3_column_int64` only under
// `int64`, which the engine does not set — flipping it would change every
// value the engine hands anyone). So a stored 4294967303 arrives as 7, and a
// label derived from that is a label for a different row's key. SQLite renders
// the value instead, which is exact whatever the accessor would have done:
//   - the rowid, so the read-back addresses the row that was written rather
//     than whichever row shares its low 32 bits;
//   - a rule input holding an INTEGER, so the evaluator sees the digits it
//     would see on the read side, which reads whole integers already.
// Only the INTEGER storage class is rendered: a REAL rendered to text would
// reach the evaluator as a string and be gated on, where the read side refuses
// it, and the two sides deriving different labels is the thing this evaluator
// exists to prevent.
const rowidText = (rowid: string) => `CAST(${rowid} AS TEXT)`;
const renderedInput = (column: string) => {
  const id = quoteIdent(column);
  return `CASE WHEN typeof(${id}) = 'integer' THEN CAST(${id} AS TEXT) ` +
    `ELSE ${id} END AS ${id}`;
};

/**
 * Execute a commit-folded `sqlite` write. Plain `runWrite` unless the db
 * declares a per-row label rule; then the write is attributed to its target
 * table and, when that table is rule-bearing, every affected row is read back
 * by rowid and re-derived through the shared evaluator — throwing
 * {@link RowLabelCommitError} (rolling back the commit) on any failure.
 * Zero additional cost for rule-less dbs.
 */
export function applySqliteCommitWrite(
  db: Database,
  op: SqliteOperation,
): WriteResult {
  const tables = op.db.tables;
  const hasRules = tables !== undefined &&
    Object.values(tables).some(tableDeclaresRowLabel);
  if (!hasRules) return runWrite(db, op.sql, op.params);

  // Vet the ORIGINAL statement exactly like runWrite would (single guarded
  // INSERT/UPDATE/DELETE); the only modification made below is a fixed
  // `RETURNING` suffix.
  assertWriteSafe(op.sql);

  // Resolve the TARGET before any shape check, mirroring the runner gate's
  // order: a write to a rule-less table keeps the plain path whatever its
  // shape (e.g. a CTE-fronted INSERT into a rule-less table of a mixed db).
  const blanked = blankWriteSql(op.sql);
  const targetName = parseWriteTable(op.sql, blanked);
  if (targetName === undefined) {
    return fail(
      "cannot attribute this write's target table, and the db declares " +
        "row-label rules",
    );
  }
  const lcTarget = targetName.toLowerCase();
  const declaredKey = Object.keys(tables).find(
    (k) => k.toLowerCase() === lcTarget,
  );
  if (declaredKey === undefined) {
    return fail(
      `write targets undeclared table "${targetName}" in a db that ` +
        "declares row-label rules",
    );
  }
  const declared = tables[declaredKey];
  if (!tableDeclaresRowLabel(declared)) {
    return runWrite(db, op.sql, op.params); // rule-less target table
  }

  const kw = blanked.match(/^\s*(insert|replace|update|delete)\b/i)?.[1]
    ?.toUpperCase();
  if (kw === undefined) {
    // e.g. a CTE-fronted write targeting the rule-bearing table — the runner
    // gate rejects the same shape.
    return fail(
      `unrecognized write shape targeting rule-bearing table ` +
        `"${declaredKey}" (use a plain INSERT/UPDATE/DELETE)`,
    );
  }

  const spec = (declared as { rowLabel: RowLabelSpec }).rowLabel;
  const properties =
    (declared as { properties?: Record<string, unknown> }).properties ?? {};
  const columnNames = Object.keys(properties);
  // `db.tables` is wire-supplied: re-validate before evaluating anything —
  // "couldn't validate" is never "no label".
  const invalid = validateRowLabelSpec(spec, columnNames, properties);
  if (invalid) {
    return fail(
      `table "${declaredKey}" declares an invalid rowLabel rule — ${invalid}`,
    );
  }

  if (kw === "DELETE") return runWrite(db, op.sql, op.params); // stores nothing

  // Scan for a pre-existing RETURNING with quoted identifiers blanked too —
  // a column literally named `"returning"` is an identifier, not the clause
  // (blankWriteSql only blanks strings/comments). A BARE `returning`
  // identifier still trips this and fails closed: over-reject, never admit.
  const identBlanked = blanked.replace(/"[^"]*"|`[^`]*`|\[[^\]]*\]/g, " ");
  if (/\breturning\b/i.test(identBlanked)) {
    return fail(
      `a write to rule-bearing table "${declaredKey}" must not carry a ` +
        "RETURNING clause (commit-time evaluation appends its own; db.exec " +
        "returns void, so the clause has no consumer)",
    );
  }

  // `rowid` (and its aliases) can be shadowed by a declared column; pick an
  // unshadowed name so the RETURNING output and the read-back WHERE address
  // the real rowid. All cell-db tables are rowid tables (createTableSQL never
  // emits WITHOUT ROWID).
  const lcColumns = new Set(columnNames.map((c) => c.toLowerCase()));
  const rowidName = ["rowid", "_rowid_", "oid"].find(
    (n) => !lcColumns.has(n),
  );
  if (rowidName === undefined) {
    return fail(
      `every rowid alias is shadowed by a declared column of ` +
        `"${declaredKey}" — affected rows cannot be identified`,
    );
  }
  if (lcColumns.has("__cf_rowid")) {
    return fail(
      `table "${declaredKey}" declares a column named "__cf_rowid", which ` +
        "collides with the commit-evaluation rowid alias",
    );
  }

  // Execute with the affected rowids returned. Stepping to completion
  // (`.all()`) both applies the DML and collects the rows; `db.changes` must
  // then equal the returned row count — a mismatch means the suffix did not
  // take effect (e.g. the statement ends inside an unterminated block comment
  // that swallowed it), so fail closed rather than under-evaluate.
  const execSql = op.sql.replace(/[\s;]+$/, "") +
    `\nRETURNING ${rowidText(rowidName)} AS __cf_rowid`;
  let returned: Record<string, unknown>[];
  let changes: number;
  const stmt = db.prepare(execSql);
  try {
    returned = stmt.all(...bindArgs(op.params));
    changes = db.changes;
  } finally {
    stmt.finalize();
  }
  const lastInsertRowid = db.lastInsertRowId;
  if (returned.length !== changes) {
    return fail(
      `affected-row identification is incomplete for rule-bearing table ` +
        `"${declaredKey}" (${changes} change(s), ${returned.length} ` +
        "returned row(s))",
    );
  }
  const result: WriteResult = { changes, lastInsertRowid };
  if (returned.length === 0) return result; // nothing stored (no-op write)
  if (returned.length > MAX_ROW_LABEL_EVAL_ROWS) {
    return fail(
      `statement affects ${returned.length} rows of rule-bearing table ` +
        `"${declaredKey}" (cap ${MAX_ROW_LABEL_EVAL_ROWS})`,
    );
  }

  const rowids: string[] = [];
  const seen = new Set<string>();
  for (const row of returned) {
    const id = row.__cf_rowid;
    if (!isRowidValue(id)) {
      return fail(
        `affected-row identification returned a non-integer rowid for ` +
          `"${declaredKey}"`,
      );
    }
    if (seen.has(id)) continue; // same row touched twice by one statement
    seen.add(id);
    rowids.push(id);
  }

  const ctx = { dbOwner: op.db.owner };
  const inputFields = ruleInputFields(spec);
  if (inputFields.length === 0) {
    // Row-independent rule (constant()/dbOwner() only): evaluate once.
    const res = evaluateRowLabel(spec, {}, ctx);
    if ("error" in res) {
      return fail(
        `rowLabel rule failed for table "${declaredKey}" — ${res.error}`,
      );
    }
    return result;
  }

  // Read the committed rows back by rowid — the TRUE post-image, immune to
  // RETURNING's same-statement timing caveats — selecting exactly the rule's
  // input columns. A rule input missing from the physical table (a schema
  // evolved after the file was created — additive DDL creates tables only)
  // makes this SELECT throw: fail closed, matching the read side, which
  // refuses queries over the same gap.
  const selectCols = inputFields.map(renderedInput).join(", ");
  for (let at = 0; at < rowids.length; at += READ_BACK_CHUNK) {
    const chunk = rowids.slice(at, at + READ_BACK_CHUNK);
    // The digits bind as text and cast back to the integer inside SQL, so the
    // comparison is still rowid-to-rowid and still takes the rowid index.
    const readSql = `SELECT ${rowidText(rowidName)} AS __cf_rowid, ` +
      `${selectCols} FROM ${quoteIdent(declaredKey)} WHERE ${rowidName} IN (${
        chunk.map(() => "CAST(? AS INTEGER)").join(", ")
      })`;
    const readStmt = db.prepare(readSql);
    let rows: Record<string, unknown>[];
    try {
      rows = readStmt.all(...bindArgs(chunk));
    } finally {
      readStmt.finalize();
    }
    if (rows.length !== chunk.length) {
      return fail(
        `read-back of rule-bearing table "${declaredKey}" found ` +
          `${rows.length} of ${chunk.length} affected rows`,
      );
    }
    for (const row of rows) {
      const values: Record<string, unknown> = {};
      for (const f of inputFields) values[f] = row[f];
      const res = evaluateRowLabel(spec, values, ctx);
      if ("error" in res) {
        return fail(
          `rowLabel rule rejected committed row (rowid ${row.__cf_rowid}) ` +
            `of table "${declaredKey}" — ${res.error}`,
        );
      }
    }
  }
  return result;
}
