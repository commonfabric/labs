/**
 * The `anchorsOf()` builtin, which returns a collaborative field's anchors as
 * Memory last wrote them to the field's anchors document, as confidential as
 * the field itself.
 */

import { internSchema } from "@commonfabric/data-model-schema";

import { type Cell, isCell } from "../cell.ts";
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
 * anchorsOf(field) — the anchors document of the string field the `field`
 * input names, `{ epoch, version, anchors }`, or `undefined` while there is
 * none or the input names no cell.
 *
 * An anchor's range and id say what the field's text holds: where text is,
 * how long it is, what was deleted, and whatever its writer put in the id.
 * So the node reads the field's value as well as the anchors document, and
 * that read puts the field's label into the transaction that writes the
 * result, as it would for any derivation of the field: a reader of the result
 * is tainted as a reader of the field is. The read also runs the node again
 * whenever the field changes.
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
    const field = inputsCell.asSchema(ANCHORS_OF_ARGUMENT_SCHEMA).withTx(tx)
      .get()?.field;
    if (!isCell(field)) {
      sendResult(tx, undefined);
      return;
    }
    // Resolution follows the link chain to the stored field, as the field's
    // own `addAnchor()` does, so both name the one document.
    const text = field.withTx(tx).resolveAsCell();
    text.getRaw();
    sendResult(
      tx,
      runtime.getCellFromLink(
        anchorsDocumentLink(text.getAsNormalizedFullLink()),
        undefined,
        tx,
      ).getRaw(),
    );
  };
}
