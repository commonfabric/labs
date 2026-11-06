/**
 * The `anchorsOf()` builtin, which names a collaborative field's anchors
 * document, so that a pattern reads and writes the field's anchors as it does
 * any cell.
 */

import { debugStr } from "@commonfabric/data-model";

import type { Cell } from "../cell.ts";
import { anchorsDocumentLink } from "../field-anchors.ts";
import { hasInlineCellScheme } from "../immutable-cell.ts";
import { resolveLink } from "../link-resolution.ts";
import type { Runtime } from "../runtime.ts";
import type { Action } from "../scheduler.ts";
import { UnresolvedInputError } from "../schema-view.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

/**
 * anchorsOf(field) — a write redirect to the anchors document of the string
 * field the `field` input names. A read of the result reads the document, a
 * map from anchor id to offset, or `undefined` until something writes it, and
 * a write of the result writes the document.
 *
 * The node reads where the field is stored and nothing of what it holds, so
 * it runs again only when the input names a different field. What a reader of
 * the anchors may learn is decided by the document's own label.
 *
 * @throws `UnresolvedInputError` while the link chain to the field passes a
 *   document this replica has not received, so the node runs again once it
 *   arrives. Throws when the input is a value stored in no document, such as
 *   a constant, which has no edits to move anchors through. Since the node
 *   reads nothing of the field, a stored value that is not a string is not
 *   refused here.
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
    // whose address the document's id is derived from. A chain that stops at
    // a document still loading names that document, not the field. The
    // second resolution repeats the first from the transaction's memo, so it
    // leaves the pull of any hop in another space to the first.
    const field = inputsCell.withTx(tx).key("field");
    const stored = field.resolveAsCell().getAsNormalizedFullLink();
    const reached = resolveLink(
      runtime,
      tx,
      field.getAsNormalizedFullLink(),
      "value",
      { kickCrossSpaceTargets: false },
    );
    if (reached.pendingHopDoc) {
      tx.readValueOrThrow(reached);
      const refusal = new UnresolvedInputError(reached);
      tx.noteSchemaRefusal(refusal);
      throw refusal;
    }
    if (hasInlineCellScheme(stored.id)) {
      throw new Error(
        debugStr`\`anchorsOf()\` needs a field stored in a document; its ` +
          debugStr`input is the inline value $quote${stored.id}`,
      );
    }
    sendResult(
      tx,
      runtime.getCellFromLink(anchorsDocumentLink(stored), undefined, tx)
        .getAsWriteRedirectLink(),
    );
  };
}
