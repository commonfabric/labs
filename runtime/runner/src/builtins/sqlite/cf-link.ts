// _cf_link codec (spec docs/specs/sqlite-builtin/02).
//
// A column whose name ends in `_cf_link` stores a cell reference as an absolute
// sigil-link JSON string. On write a cell is encoded; on read the string is
// decoded back to a live Cell. Cells may only be persisted via link columns —
// binding a cell to any other column throws (enforced by the write builtin),
// and a non-cell bound to a link column throws here.

import { portableSnapshotId } from "../../data-uri.ts";
import type { JSONSchema } from "../../builder/types.ts";
import type { Runtime } from "../../runtime.ts";
import type { Cell } from "../../cell.ts";
import { asBoundCell } from "../../cell.ts";
import type { IExtendedStorageTransaction } from "../../storage/interface.ts";
import {
  encodeCellToSigilString,
  parseCfLinkToSigil,
} from "./cf-link-codec.ts";

// Pure column-name helpers live in the memory package (server-authoritative,
// lower pace-layer) and are re-exported here for client-side use.
export {
  CF_LINK_SUFFIX,
  isCfLinkColumn,
} from "@commonfabric/memory/sqlite/columns";

// The pure sigil parse/validate prologue lives in the cycle-free codec; re-export
// it so existing importers (e.g. sqlite-builtins.ts) keep their import path.
export { parseCfLinkToSigil } from "./cf-link-codec.ts";

/**
 * Encode a cell reference to an absolute sigil-link JSON string for storage.
 * The link is absolute (carries id, space, scope) so the row is resolvable
 * independent of any base document or space. Throws if `value` is not a cell.
 */
export function encodeCfLinkValue(value: unknown): string {
  const cell = asBoundCell(value);
  if (!cell) {
    throw new TypeError(
      "_cf_link columns store cell references only; got a non-cell value",
    );
  }
  return encodeCellToSigilString(cell, portableSnapshotId);
}

/**
 * Decode a stored `_cf_link` value back to a live Cell. `null` decodes to null.
 * Throws on non-null, non-string values, on malformed JSON, or on JSON that is
 * not a single sigil link.
 */
export function decodeCfLinkValue(
  value: unknown,
  runtime: Runtime,
  schema?: JSONSchema,
  tx?: IExtendedStorageTransaction,
): Cell<unknown> | null {
  const sigil = parseCfLinkToSigil(value);
  if (sigil === null) return null;
  return runtime.getCellFromLink(sigil, schema, tx);
}
