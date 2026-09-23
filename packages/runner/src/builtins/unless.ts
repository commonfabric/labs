import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { resolveLink } from "../link-resolution.ts";
import { ownedCell } from "./runtime-owned-store.ts";
import { ownedResultCause, resolvedCellScope } from "./scope-policy.ts";
import { parseLink } from "../link-utils.ts";
import type { RawNodeCause } from "../module.ts";
import { ContextualFlowControl } from "../cfc.ts";

/**
 * unless(condition, fallback) - || semantics
 * Returns condition if truthy, otherwise returns fallback
 */
export function unless(
  inputsCell: Cell<{ condition: any; fallback: any }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: RawNodeCause,
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  return (tx: IExtendedStorageTransaction) => {
    const conditionCell = inputsCell.key("condition");
    const resultScope = resolvedCellScope(runtime, tx, conditionCell);
    // Keyed on the output spot, never on the inputs document (see
    // `ownedResultCause`).
    const result = ownedCell<any>(
      runtime,
      tx,
      parentCell,
      ownedResultCause("unless", cause, parentCell),
      undefined,
      resultScope,
    );
    sendResult(tx, result);
    const resultWithLog = result.withTx(tx);
    const inputsWithLog = inputsCell.withTx(tx);

    const condition = inputsWithLog.key("condition").get();

    // || semantics: if truthy, return condition; if falsy, return fallback
    const ref = condition
      ? inputsWithLog.key("condition").getAsLink({ base: result })
      : inputsWithLog.key("fallback").getAsLink({ base: result });
    const resolvedRef = resolveLink(runtime, tx, parseLink(ref, result));
    // A stream is declared by its link's schema and holds no value, so the
    // reference written here carries that schema along; a reader following
    // it to the stream's document would otherwise find nothing that says
    // what the position is.
    const serializedRef = runtime.getCellFromLink(resolvedRef).getAsLink({
      base: result,
      includeSchema: ContextualFlowControl.declaresStream(resolvedRef.schema),
    });

    resultWithLog.setRawUntyped(serializedRef);
  };
}
