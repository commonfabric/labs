import { internSchema } from "@commonfabric/data-model-schema";

import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

/**
 * Argument schema for `str`. Both inputs are value-read: a substitution that
 * resolves to a cell is read through this schema, so the node re-runs when
 * that cell changes, and the interpolation sees the value rather than a link.
 */
export const STR_ARGUMENT_SCHEMA = internSchema({
  type: "object",
  properties: {
    strings: { type: "array", items: { type: "string" } },
    values: { type: "array" },
  },
});

/**
 * `str` — interpolate a template literal whose substitutions may be reactive.
 *
 * Concatenation matches a native template literal exactly, including how it
 * renders `undefined`, `null`, and objects: authors reach for this in place of
 * a template literal precisely because the cells inside it are reactive, so
 * the rendering rules should not shift underneath them.
 */
export function str(
  inputsCell: Cell<{ strings: string[]; values: unknown[] }>,
  sendResult: (tx: IExtendedStorageTransaction, result: string) => void,
): Action {
  return (tx: IExtendedStorageTransaction) => {
    const inputs = inputsCell.asSchema(STR_ARGUMENT_SCHEMA).withTx(tx).get();
    const strings = inputs?.strings ?? [];
    const values = inputs?.values ?? [];
    sendResult(
      tx,
      strings.reduce(
        (result, chunk, i) =>
          result + chunk + (i < values.length ? values[i] : ""),
        "",
      ),
    );
  };
}
