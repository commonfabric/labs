// Pure `_cf_link` codec — the cell↔sigil-string encode and the sigil
// parse/validate prologue — shared by BOTH the write path (`encodeSqliteParams`
// / `db.exec` in cell.ts) and the read/write helpers in cf-link.ts, so they
// produce and parse BYTE-IDENTICAL sigil strings.
//
// Cell is a type-only import. Native snapshots are made portable at this
// string boundary because SQLite rows can outlive their creating runtime.
// The caller supplies conversion, keeping runtime cell imports out of this codec.

import type { Cell } from "../../cell.ts";
import type { URI } from "../../sigil-types.ts";
import type { NormalizedFullLink } from "../../link-types.ts";
import {
  type CellLink,
  createSigilLinkFromParsedLink,
  isCellLink,
} from "../../link-utils.ts";

/**
 * Encode a bound Cell to the stored `_cf_link` sigil-link JSON string: an
 * ABSOLUTE link (id + space + scope, no `base`) with `schema`/`asCell` stripped
 * (`includeSchema: false`), so the row resolves independent of any base
 * document and stores no schema flags.
 */
export function encodeCellToSigilString(
  cell: Cell<unknown>,
  portableId: (id: URI) => URI,
): string {
  const link: NormalizedFullLink = cell.getAsNormalizedFullLink();
  const sigil = createSigilLinkFromParsedLink({
    ...link,
    id: portableId(link.id),
  }, { includeSchema: false });
  return JSON.stringify(sigil);
}

/**
 * Parse + validate a stored `_cf_link` value to its sigil-link OBJECT (or `null`
 * for SQL NULL). This is the shared prologue of both `decodeCfLinkValue` (which
 * then hydrates the sigil to a live Cell via the runtime) and the `asCell`
 * query-result read path (which stores the sigil for deferred rehydration).
 * Throws on a non-null/non-string value, malformed JSON, or JSON that is not a
 * single sigil link.
 */
export function parseCfLinkToSigil(value: unknown): CellLink | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new TypeError(
      `_cf_link columns hold a sigil-link string or NULL; got ${typeof value}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("_cf_link value is not valid JSON");
  }
  if (!isCellLink(parsed)) {
    throw new TypeError("_cf_link value is not a sigil link");
  }
  return parsed;
}
