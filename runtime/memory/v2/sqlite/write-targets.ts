// Map each positional `?` in a write statement to the column it writes — for the
// CFC write-ceiling check (a labeled value must fit its target column's ceiling).
//
// CONSERVATIVE + FAIL-CLOSED. Returns `undefined` for any shape it can't
// confidently attribute (columnless INSERT, INSERT…SELECT, upsert, a complex SET
// expression, a subquery in SET, mixed/named params); the caller then REJECTS a
// labeled value it cannot verify. A column write maps to the column name; a
// non-column param (e.g. a `WHERE` filter value, a `DELETE` filter) maps to
// `null` (no ceiling check needed). A complex `WHERE` is fine — its params are
// simply `null` — only a complex SET/target fails closed.
//
// SHARED module (in `runtime/memory` beside `row-label.ts` for the same
// reason): the runner's write gates (`write-ceiling.ts`, `row-label-write.ts`)
// and the server's commit-time row-label re-derivation (`commit-eval.ts`, CFC
// Phase 3.c) attribute a write's target with the SAME parser, so the sides
// cannot drift on which statements they consider attributable.
//
// Pure module: no FFI, no engine imports — safe for client-side import.

/** Blank string literals and comments to spaces so `?`/keywords/`,` inside them
 *  can't fool the structural checks. Identifiers are left intact. */
function blankStringsAndComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === "-" && d === "-") {
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += " '' "; // a blanked string literal placeholder (no inner chars)
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Count positional `?` placeholders (the blanked SQL has no string `?`s). A
 *  named/numbered param (`:x`, `@x`, `$x`, `?1`) makes positional attribution
 *  unsafe → caller should fail closed; we surface that via `hasNonPositional`. */
function placeholderInfo(
  blanked: string,
): { count: number; hasNonPositional: boolean } {
  let count = 0;
  let hasNonPositional = false;
  for (let i = 0; i < blanked.length; i++) {
    const c = blanked[i];
    if (c === "?") {
      // `?NNN` numbered params are non-positional for our purposes.
      if (/[0-9]/.test(blanked[i + 1] ?? "")) hasNonPositional = true;
      else count++;
    } else if (c === ":" || c === "@" || c === "$") {
      if (/[A-Za-z_]/.test(blanked[i + 1] ?? "")) hasNonPositional = true;
    }
  }
  return { count, hasNonPositional };
}

const COLUMN_LIST_VALUES =
  /\binsert\b[\s\S]*?\binto\b\s+[^()]+?\(([^)]*)\)\s*values\b/i;

function leadingKeyword(blanked: string): string {
  return (blanked.match(/[A-Za-z]+/)?.[0] ?? "").toUpperCase();
}

function unquoteIdent(raw: string): string {
  return raw.trim().replace(/^["'`[]|["'`\]]$/g, "");
}

/** Blank string literals/comments so the structural parsers can't be fooled by
 *  `?`/keywords/commas inside them. Exposed so a caller parsing the SAME SQL for
 *  both table and param-columns can blank once and pass it to both. */
export function blankWriteSql(sql: string): string {
  return blankStringsAndComments(sql);
}

/** The single target table of a write (`INSERT INTO t`, `UPDATE t`,
 *  `DELETE FROM t`), unquoted; undefined if it can't be confidently extracted
 *  (e.g. a schema-qualified or unusual form). Used to resolve a column's `ifc`. */
export function parseWriteTable(
  sql: string,
  blanked: string = blankStringsAndComments(sql),
): string | undefined {
  const b = blanked;
  // The UPDATE alternative skips an optional `OR <conflict-action>` so the table
  // isn't mis-read as the action keyword (`UPDATE OR REPLACE t` → `t`, not `OR`).
  // INSERT/REPLACE reach the table via `INTO`, so their own `OR <action>` is
  // already consumed by the lazy `[\s\S]*?`.
  const ident = String.raw`"[^"]+"|\`[^\`]+\`|\[[^\]]+\]|[A-Za-z_][\w$]*`;
  const m = b.match(
    new RegExp(
      String.raw`\b(?:insert|replace)\b[\s\S]*?\binto\b\s+(${ident})` +
        String
          .raw`|\bupdate\b\s+(?:or\s+(?:rollback|abort|replace|fail|ignore)\s+)?(${ident})` +
        String.raw`|\bdelete\b\s+from\s+(${ident})`,
      "i",
    ),
  );
  if (!m) return undefined;
  const raw = m[1] ?? m[2] ?? m[3];
  if (!raw) return undefined;
  // Schema-qualified (`main.t`, `"main"."t"`): the identifier capture stops at
  // the dot, so also reject when a `.` immediately follows the matched table
  // token. Either way → fail closed (we don't model cross-schema columns).
  const after = b.slice((m.index ?? 0) + m[0].length);
  if (/^\s*\./.test(after) || raw.includes(".")) return undefined;
  return unquoteIdent(raw);
}

export function parseWriteParamColumns(
  sql: string,
  blanked: string = blankStringsAndComments(sql),
): (string | null)[] | undefined {
  const { count, hasNonPositional } = placeholderInfo(blanked);
  if (hasNonPositional) return undefined; // mixed/named/numbered → fail closed
  if (count === 0) return [];

  const kw = leadingKeyword(blanked);

  if (kw === "DELETE") {
    // DELETE writes no column values; every param is a filter → null.
    return new Array(count).fill(null);
  }

  if (kw === "INSERT" || kw === "REPLACE") {
    // Upsert binds params in a trailing DO UPDATE SET — positional cycling would
    // mis-map them. Fail closed.
    if (/\bon\s+conflict\b/i.test(blanked)) return undefined;
    const m = blanked.match(COLUMN_LIST_VALUES);
    if (!m) return undefined; // columnless INSERT or INSERT…SELECT → fail closed
    const cols = m[1].split(",").map(unquoteIdent);
    if (cols.length === 0 || cols.some((c) => c.length === 0)) return undefined;
    // Positional cycling (`cols[i % cols.length]`) is sound ONLY when every value
    // slot is a bare `?`. An interleaved literal/expression (`VALUES ('x', ?)`,
    // `VALUES (?, 1)`, `VALUES (lower(?))`) shifts the `?`→column alignment, so
    // verify the value region (after VALUES, up to a top-level RETURNING — ON
    // CONFLICT already rejected) contains ONLY `?`, parens, commas, whitespace.
    // A blanked string shows as `''`; a number/identifier/operator shows
    // literally — any of those → fail closed.
    const afterValues = blanked.slice((m.index ?? 0) + m[0].length);
    const retIdx = afterValues.search(/\breturning\b/i);
    const region = retIdx === -1 ? afterValues : afterValues.slice(0, retIdx);
    // Bare `?` tuples only — plus an optional trailing statement terminator
    // (`;`). Any interleaved literal/expression → fail closed.
    if (!/^[\s?(),]*;?\s*$/.test(region)) return undefined;
    // Positional params cycle across multi-row `VALUES (?),(?)` tuples.
    return Array.from({ length: count }, (_, i) => cols[i % cols.length]);
  }

  if (kw === "UPDATE") {
    const setCols = parseUpdateSetColumns(sql, blanked);
    if (setCols === undefined) return undefined;
    // SET params come first (one `?` each, before WHERE); remaining params (in
    // WHERE/RETURNING) write no column.
    if (setCols.length > count) return undefined;
    return Array.from(
      { length: count },
      (_, idx) => (idx < setCols.length ? setCols[idx] : null),
    );
  }

  return undefined; // unknown write shape → fail closed
}

/**
 * The column names an UPDATE's SET clause writes — independent of bind params,
 * so a LITERAL assignment (`SET col = 'x'`, zero placeholders) is still
 * attributed. Only the strict `ident = ?` form is accepted; any literal,
 * expression, subquery, or tuple assignment ⟹ undefined (fail closed). Used by
 * the param→column mapper above and by the CFC row-label write gate, which
 * must reject an UPDATE it cannot attribute on a rule-bearing table.
 */
export function parseUpdateSetColumns(
  sql: string,
  blanked: string = blankStringsAndComments(sql),
): string[] | undefined {
  // Isolate the SET region: between the first top-level `SET` and the first
  // top-level boundary keyword (WHERE/RETURNING/FROM) or end. Track paren depth
  // so a subquery's own WHERE/comma doesn't end the region prematurely.
  const setIdx = blanked.search(/\bset\b/i);
  if (setIdx === -1) return undefined;
  let i = setIdx + 3;
  let depth = 0;
  let region = "";
  for (; i < blanked.length; i++) {
    const c = blanked[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    if (depth === 0) {
      const rest = blanked.slice(i);
      if (/^\s*\b(where|returning|from)\b/i.test(rest)) break;
    }
    region += c;
  }
  if (depth !== 0) return undefined; // unbalanced → fail closed
  // The SET region must be ONLY simple `ident = ?` assignments (top-level
  // commas). A parenthesis, subquery, or non-`?` value → fail closed.
  if (region.includes("(") || region.includes(")")) return undefined;
  const assignments = region.split(",");
  const setCols: string[] = [];
  for (const a of assignments) {
    const m = a.match(
      /^\s*("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*)\s*=\s*\?\s*$/,
    );
    if (!m) return undefined; // not exactly `ident = ?` → fail closed
    setCols.push(unquoteIdent(m[1]));
  }
  return setCols;
}
