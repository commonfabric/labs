import type { Cell } from "./cell.ts";
import { rawMetaWriteAuthorization } from "./meta-seam.ts";

/**
 * Writes `cell`'s `result` meta field: a write-redirect link, schema included,
 * to `resultCell`, the result cell `cell` belongs to. Following these links
 * from an owned cell is how the runtime finds the piece responsible for it.
 */
export function setResultCell(cell: Cell<unknown>, resultCell: Cell<unknown>) {
  cell.setMetaRaw(
    "result",
    resultCell.getAsWriteRedirectLink({ includeSchema: true }),
    rawMetaWriteAuthorization,
  );
}
