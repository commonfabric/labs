/**
 * The `anchorsOf()` builtin, which names a collaborative field's anchors
 * document, so that a pattern reads and writes the field's anchors as it does
 * any cell.
 */

import { internSchema } from "@commonfabric/data-model-schema";

import type { Cell } from "../cell.ts";
import { anchorsDocumentLink } from "../field-anchors.ts";
import type { Runtime } from "../runtime.ts";
import type { Action } from "../scheduler.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

/**
 * Argument schema for `anchorsOf`. The field rides the input as a cell, so
 * the node receives its link, which names its anchors document.
 */
export const ANCHORS_OF_ARGUMENT_SCHEMA = internSchema({
  type: "object",
  properties: { field: { type: "string", asCell: ["cell"] } },
});

/**
 * anchorsOf(field) — a write redirect to the anchors document of the string
 * field the `field` input names. A read of the result reads the document, a
 * map from anchor id to offset, or `undefined` until something writes it, and
 * a write of the result writes the document.
 *
 * The node reads where the field is stored and nothing of what it holds, so
 * it runs again only when the input names a different field. What a reader of
 * the anchors may learn is decided by the document's own label.
 */
export function anchorsOf(
  inputsCell: Cell<{ field: unknown }>,
  sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
  _addCancel: (cancel: () => void) => void,
  _cause: Cell<unknown>[],
  _parentCell: Cell<unknown>,
  runtime: Runtime,
): Action {
  return (tx: IExtendedStorageTransaction) => {
    // Resolution follows the link chain from the input to the stored field,
    // whose address the document's id is derived from.
    const stored = inputsCell.withTx(tx).key("field").resolveAsCell()
      .getAsNormalizedFullLink();
    sendResult(
      tx,
      runtime.getCellFromLink(anchorsDocumentLink(stored), undefined, tx)
        .getAsWriteRedirectLink(),
    );
  };
}
