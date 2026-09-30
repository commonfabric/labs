import { type Cell } from "../cell.ts";
import { type Action } from "../scheduler.ts";
import { type Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { ownedCell } from "./runtime-owned-store.ts";
import { resolveCellReference } from "./resolve-cell-reference.ts";
import { ownedResultCause, resolvedCellScope } from "./scope-policy.ts";
import type { RawNodeCause } from "../module.ts";
import { ContextualFlowControl } from "../cfc.ts";

/**
 * when(condition, value) - && semantics
 * Returns value if condition is truthy, otherwise returns condition (falsy value)
 */
export function when(
  inputsCell: Cell<{ condition: any; value: any }>,
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
      ownedResultCause("when", cause, parentCell),
      undefined,
      resultScope,
    );
    sendResult(tx, result);
    const resultWithLog = result.withTx(tx);
    const inputsWithLog = inputsCell.withTx(tx);

    const condition = inputsWithLog.key("condition").get();

    // && semantics: if truthy, return value; if falsy, return condition
    const selected = inputsWithLog.key(condition ? "value" : "condition");
    const resolved = resolveCellReference(runtime, tx, selected);
    const serializedRef = resolved.getAsLink({
      base: result,
      includeSchema: ContextualFlowControl.declaresStream(
        resolved.getAsNormalizedFullLink().schema,
      ),
    });

    resultWithLog.setRawUntyped(serializedRef);
  };
}
