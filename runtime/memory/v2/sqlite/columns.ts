// Pure `_cf_link` column-name helpers, shared by the server (this package) and
// the client-side codec (runner). No runtime/FFI dependencies.

export const CF_LINK_SUFFIX = "_cf_link";

/** A column/parameter is a link column iff its name ends in `_cf_link` (with a
 *  non-empty prefix). */
export function isCfLinkColumn(name: string): boolean {
  return name.length > CF_LINK_SUFFIX.length && name.endsWith(CF_LINK_SUFFIX);
}

/** The five column affinities SQLite derives from a declared type name. */
export type SqlAffinity = "integer" | "text" | "blob" | "real" | "numeric";

/**
 * The affinity SQLite gives a column declared `sqlType`, by the rules in its
 * datatype documentation (§3.1): the first matching substring wins, and a
 * type naming none of them is NUMERIC. Callers use it to reason about what a
 * column will do to a value on the way in — a rule gate reads what was
 * STORED, and affinity is what decides whether that is what was bound.
 */
export function sqlAffinity(sqlType: string): SqlAffinity {
  const type = sqlType.toUpperCase();
  if (type.includes("INT")) return "integer";
  if (type.includes("CHAR") || type.includes("CLOB") || type.includes("TEXT")) {
    return "text";
  }
  if (type.includes("BLOB") || type.trim() === "") return "blob";
  if (type.includes("REAL") || type.includes("FLOA") || type.includes("DOUB")) {
    return "real";
  }
  return "numeric";
}
