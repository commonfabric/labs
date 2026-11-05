// CFC write-ceiling check (Phase 2): a value bound to a labeled column must fit
// that column's `ifc.maxConfidentiality`. The label rides the bound value (a Cell
// or any carried-label value — read via `cfcLabelViewForCellFailClosed` at the call site);
// this module is pure (the reader is injected) so it stays free of cell.ts.
//
// FAIL CLOSED: if a value carries confidentiality but its target column can't be
// determined (a write shape `parseWriteParamColumns` won't attribute), the write
// is rejected rather than let through unverified. Unlabeled values and columns
// without a ceiling are unaffected (zero behavior change until `ifc` is used).

import {
  blankWriteSql,
  parseWriteParamColumns,
  parseWriteTable,
} from "@commonfabric/memory/sqlite/write-targets";

import type { CfcConfClause } from "../../cfc/clause.ts";
import { cfcObservationFitsCeiling } from "../../cfc/observation.ts";

interface ColumnIfc {
  maxConfidentiality?: readonly CfcConfClause[];
  confidentiality?: readonly CfcConfClause[];
}
type Tables = Record<
  string,
  { properties?: Record<string, { ifc?: ColumnIfc }> } | undefined
>;

/** Any column anywhere declares a read-label or a write-ceiling. */
function dbDeclaresAnyLabel(tables: Tables): boolean {
  return Object.values(tables).some((t) =>
    Object.values(t?.properties ?? {}).some((c) =>
      (c?.ifc?.maxConfidentiality !== undefined) ||
      ((c?.ifc?.confidentiality?.length ?? 0) > 0)
    )
  );
}

/** A bound-paramless RHS token that stores no column-derived data. */
function rhsIsLiteral(rhs: string): boolean {
  const t = rhs.replace(/;\s*$/, "").trim();
  return t === "" ||
    /^''$/.test(t) || // blanked string literal
    // numeric literal incl. floats, exponents (1e3), and hex (0x1)
    /^(?:[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|0[xX][0-9A-Fa-f]+)$/
      .test(t) ||
    /^(null|true|false)$/i.test(t) || // keyword literal
    t === "?"; // positional param (handled by the param path)
}

/**
 * Whether a write with no bound params moves column-derived data into a stored
 * position — `INSERT…SELECT`, or `UPDATE col = <column expr>`. Such a write
 * relabels data past a destination column's declared label and cannot be
 * attributed without bound params, so a labeled db must fail closed on it
 * (audit S6). Literal-only INSERT/UPDATE and DELETE store no column data.
 * Sound over-approximation: any non-literal RHS counts as a column reference.
 */
function paramlessRelabelRisk(blanked: string): boolean {
  const kw = /^\s*(\w+)/.exec(blanked)?.[1]?.toUpperCase();
  if (kw === "DELETE") return false;
  if (kw === "INSERT" || kw === "REPLACE") {
    // INSERT…SELECT copies column data; an ON CONFLICT … DO UPDATE clause can
    // also relabel via `SET col = other_col`, so treat any upsert DO UPDATE as
    // risky (the bound-param parser likewise fails closed on upserts).
    return /\bselect\b/i.test(blanked) || /\bdo\s+update\b/i.test(blanked);
  }
  if (kw === "UPDATE") {
    const setIdx = blanked.search(/\bset\b/i);
    if (setIdx === -1) return true; // unparseable → fail closed
    let depth = 0;
    let region = "";
    for (let i = setIdx + 3; i < blanked.length; i++) {
      const c = blanked[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      if (
        depth === 0 &&
        /^\s*\b(where|returning|from)\b/i.test(blanked.slice(i))
      ) break;
      region += c;
    }
    if (depth !== 0) return true; // unbalanced → fail closed
    // Split top-level assignments and inspect each RHS.
    let d = 0;
    let current = "";
    const parts: string[] = [];
    for (const c of region) {
      if (c === "(") d++;
      else if (c === ")") d--;
      if (c === "," && d === 0) {
        parts.push(current);
        current = "";
      } else current += c;
    }
    parts.push(current);
    for (const part of parts) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      if (!rhsIsLiteral(part.slice(eq + 1))) return true;
    }
    return false;
  }
  return true; // unknown shape → fail closed
}

/** Returns a violation message, or undefined if the write is within ceiling. */
export function checkSqliteWriteCeiling(
  sql: string,
  params: ReadonlyArray<unknown> | Record<string, unknown> | undefined,
  tables: Tables | undefined,
  /** The confidentiality atoms carried by a bound value ([] if unlabeled). */
  confidentialityOf: (value: unknown) => readonly unknown[],
): string | undefined {
  if (!tables) return undefined;
  // Blank string-literals/comments once; both parsers read the same SQL.
  const blanked = blankWriteSql(sql);
  const table = parseWriteTable(sql, blanked);

  // Paramless writes carry no bound values to attribute, so the per-value ceiling
  // check below has nothing to inspect. A column-to-column flow (INSERT…SELECT,
  // UPDATE col = col) would still relabel data past a destination column's
  // declared label. On a labeled db, fail closed for such shapes (audit S6).
  // An empty bound-param array is the same no-bound-value flow as `undefined`.
  if (params === undefined || (Array.isArray(params) && params.length === 0)) {
    if (dbDeclaresAnyLabel(tables) && paramlessRelabelRisk(blanked)) {
      return (
        "sqlite: a paramless write moves column data on a labeled database " +
        "(e.g. INSERT…SELECT or UPDATE col = col); its labels cannot be " +
        "attributed, so it is refused — use positional ? params with an " +
        "explicit column list, or literal values"
      );
    }
    return undefined;
  }

  const UNRESOLVED =
    "sqlite: a labeled value is bound in a write whose target column cannot be " +
    "determined — use an explicit column list (INSERT INTO t (col) VALUES (?)) " +
    "or a simple UPDATE (SET col = ?) with positional ? params";

  // Resolve a target column name to its declared schema entry. CRITICAL: a
  // resolution MISS (unknown table, column not declared) is NOT the same as "no
  // ceiling" — treating the two alike is the fail-open this module exists to
  // prevent. So `found:false` makes a LABELED value fail closed at the call
  // site. Identifier match is case-insensitive (SQLite folds ASCII identifier
  // case; the declared property keys may differ in case from the SQL).
  const resolveCeiling = (
    col: string,
  ): { found: boolean; ceiling?: readonly CfcConfClause[] } => {
    if (table === undefined) return { found: false };
    const props = tables[table]?.properties;
    if (!props) return { found: false };
    const lc = col.toLowerCase();
    const key = Object.keys(props).find((k) => k.toLowerCase() === lc);
    if (key === undefined) return { found: false };
    return { found: true, ceiling: props[key]?.ifc?.maxConfidentiality };
  };

  // Check one labeled value against its (named) target column. Fails closed when
  // the column can't be positively resolved.
  const checkLabeled = (
    conf: readonly CfcConfClause[],
    col: string,
  ): string | undefined => {
    const r = resolveCeiling(col);
    if (!r.found) return UNRESOLVED;
    return cfcObservationFitsCeiling(conf, r.ceiling) ? undefined : (
      `sqlite: a value bound to column "${col}" is more confidential than the ` +
      `column allows (exceeds its maxConfidentiality)`
    );
  };

  if (Array.isArray(params)) {
    const cols = parseWriteParamColumns(sql, blanked);
    for (let i = 0; i < params.length; i++) {
      const conf = confidentialityOf(params[i]);
      if (conf.length === 0) continue; // unlabeled → nothing to check
      if (cols === undefined) return UNRESOLVED; // unattributable shape
      const col = cols[i];
      if (col === null) continue; // a filter param (WHERE), not stored
      const v = checkLabeled(conf as readonly CfcConfClause[], col);
      if (v) return v;
    }
    return undefined;
  }

  // Named/object params: a placeholder name is NOT reliably the target column
  // (it's an arbitrary bind name, and without parsing we can't tell a stored
  // SET/INSERT value from a WHERE filter). So a LABELED value bound via named
  // params fails closed — checking the key as a column would either miss the
  // real ceiling (bypass) or reject a filter that isn't stored (false reject).
  // Use positional `?` with an explicit column list for a CFC-checked write.
  // Unlabeled named writes are unaffected.
  for (const value of Object.values(params)) {
    if (confidentialityOf(value).length > 0) {
      return "sqlite: a labeled value is bound via named/object params, whose " +
        "target column cannot be determined — use positional ? params with an " +
        "explicit column list (INSERT INTO t (col) VALUES (?)) or a simple " +
        "UPDATE (SET col = ?)";
    }
  }
  return undefined;
}
