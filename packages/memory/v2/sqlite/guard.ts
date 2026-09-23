// Tokenizer-level statement guard for the SQLite builtins.
//
// `@db/sqlite` exposes no `sqlite3_set_authorizer`, so we cannot have SQLite
// enumerate the objects a statement touches. Instead we apply a conservative,
// tokenizer-level guard (no full SQL parser): mask string literals and strip
// comments, then check the leading keyword, statement count, schema-qualified
// references, forbidden verbs (PRAGMA/ATTACH/DETACH), and references to core
// engine table names.
//
// This is intentionally conservative — it can have minor false positives (e.g.
// a column literally named `commit`). That residual is documented in
// docs/specs/sqlite-builtin/08-open-questions.md (Q8a). The full structural fix
// is the space-DID core-table rename, deferred behind a flag.

/** Core engine table names a pattern statement must never reference. */
export const CORE_TABLE_NAMES: readonly string[] = [
  "commit",
  "revision",
  "head",
  "snapshot",
  "branch",
  "blob_store",
  "authorization",
  "invocation",
  "op_field_epoch",
  "op_submission",
  "op_integrated",
  "op_checkpoint",
  "scheduler_basis",
  "execution_lease",
  "execution_outbox",
  "_cf_commit_watermark",
];

export type StatementKind = "select" | "write" | "other";

export type StatementClassification = {
  /** Leading-keyword classification. */
  kind: StatementKind;

  /** More than one statement (after dropping a trailing `;`). */
  multiple: boolean;

  /** A schema-qualified table reference (`db.table`) in a table position. */
  qualified: boolean;

  /** Contains a forbidden verb: PRAGMA / ATTACH / DETACH. */
  forbidden: boolean;

  /** References a core engine table name. */
  coreRef: boolean;
};

export class GuardError extends Error {
  override name = "GuardError";
  constructor(reason: string, sql: string) {
    super(`SQLite statement rejected: ${reason}\n  in: ${sql}`);
  }
}

const WRITE_LEADING = new Set(["INSERT", "UPDATE", "DELETE", "REPLACE"]);

function sanitizeIdent(inner: string): string {
  // Keep identifier word chars so table-name checks still match (e.g. "commit"
  // -> commit); neutralize any other char (`;`, keywords-with-symbols, etc.) so
  // injected separators can't fool statement-count/keyword detection. This can
  // over-reject but never under-rejects (fail-closed).
  return ` ${inner.replace(/[^A-Za-z0-9_$]/g, "_")} `;
}

/**
 * Normalize SQL for tokenizer-level inspection:
 * - strip comments,
 * - blank `'...'` STRING LITERALS (their contents are data, never identifiers),
 * - UNQUOTE `"..."`, `` `...` ``, and `[...]` IDENTIFIERS (their contents ARE
 *   identifiers in SQLite — they must remain visible to the table-name checks),
 * sanitizing identifier contents to word chars.
 */
function normalizeForGuard(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "-" && next === "-") { // line comment
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") { // block comment
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    if (ch === "'") { // string literal -> blank
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          } // '' escape
          i++;
          break;
        }
        i++;
      }
      out += " ";
      continue;
    }
    if (ch === '"' || ch === "`") { // quoted identifier -> keep contents
      const quote = ch;
      i++;
      let inner = "";
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            inner += quote;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        inner += sql[i];
        i++;
      }
      out += sanitizeIdent(inner);
      continue;
    }
    if (ch === "[") { // bracketed identifier -> keep contents
      i++;
      let inner = "";
      while (i < n && sql[i] !== "]") {
        inner += sql[i];
        i++;
      }
      i++;
      out += sanitizeIdent(inner);
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

// Forbidden schema qualifiers: a pattern never knows its own attach alias, so
// ANY schema qualifier to these is rejected (whitespace around the dot allowed).
const FORBIDDEN_SCHEMA_RE =
  /\b(?:main|temp|sqlite_[A-Za-z0-9_]*|pragma_[A-Za-z0-9_]*)\s*\./i;

// Generic schema-qualified table reference in a table position. The optional
// `OR ABORT|FAIL|IGNORE|REPLACE|ROLLBACK` conflict clause can sit between
// `UPDATE` and its target, so allow it — otherwise `UPDATE OR REPLACE s.t …`
// would slip a schema-qualified write past this check.
const TABLE_POS_QUALIFIED_RE =
  /\b(?:FROM|JOIN|INTO|UPDATE(?:\s+OR\s+(?:ABORT|FAIL|IGNORE|REPLACE|ROLLBACK))?)\s+[A-Za-z_][\w$]*\s*\.\s*[A-Za-z_][\w$]*/i;

// Core tables, sqlite_* / pragma_* introspection (sqlite_master, sqlite_schema,
// pragma_table_info table-valued functions, etc.).
const CORE_REF_RE = new RegExp(
  `\\b(?:${
    CORE_TABLE_NAMES.join("|")
  }|sqlite_[A-Za-z0-9_]*|pragma_[A-Za-z0-9_]*)\\b`,
  "i",
);

export function classifyStatement(sql: string): StatementClassification {
  const norm = normalizeForGuard(sql);
  const trimmed = norm.replace(/;[\s;]*$/, "").trim();

  const multiple = /;/.test(trimmed);

  const firstKeyword = (trimmed.match(/[A-Za-z]+/)?.[0] ?? "").toUpperCase();
  // A function call such as `replace()` is not a write command.
  const hasWriteKeyword = /\b(INSERT|UPDATE|DELETE|REPLACE)\b(?!\s*\()/i.test(
    norm,
  );

  let kind: StatementKind;
  if (WRITE_LEADING.has(firstKeyword)) {
    kind = "write";
  } else if (firstKeyword === "SELECT") {
    kind = "select";
  } else if (firstKeyword === "WITH") {
    kind = hasWriteKeyword ? "write" : "select";
  } else {
    kind = "other";
  }

  const qualified = FORBIDDEN_SCHEMA_RE.test(norm) ||
    TABLE_POS_QUALIFIED_RE.test(norm);

  const forbidden = /\b(?:PRAGMA|ATTACH|DETACH)\b/i.test(norm);

  const coreRef = CORE_REF_RE.test(norm);

  return { kind, multiple, qualified, forbidden, coreRef };
}

function assertCommon(c: StatementClassification, sql: string): void {
  if (c.multiple) {
    throw new GuardError("multiple statements are not allowed", sql);
  }
  if (c.forbidden) {
    throw new GuardError("PRAGMA/ATTACH/DETACH are not allowed", sql);
  }
  if (c.qualified) {
    throw new GuardError(
      "schema-qualified table references are not allowed",
      sql,
    );
  }
  if (c.coreRef) {
    throw new GuardError("references a reserved core table name", sql);
  }
}

/** Throw unless `sql` is a single, safe, read-only SELECT (or read-only CTE). */
export function assertReadOnly(sql: string): void {
  const c = classifyStatement(sql);
  if (c.kind !== "select") {
    throw new GuardError("only a single read-only SELECT is allowed", sql);
  }
  assertCommon(c, sql);
}

/** Throw unless `sql` is a single, safe INSERT/UPDATE/DELETE (no DDL). */
export function assertWriteSafe(sql: string): void {
  const c = classifyStatement(sql);
  if (c.kind !== "write") {
    throw new GuardError(
      "only a single INSERT/UPDATE/DELETE is allowed (DDL is owned by the database)",
      sql,
    );
  }
  assertCommon(c, sql);
}
