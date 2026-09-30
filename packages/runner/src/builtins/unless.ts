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
    const selected = inputsWithLog.key(condition ? "condition" : "fallback");
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
