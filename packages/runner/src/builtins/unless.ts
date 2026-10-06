import { type Cell } from "../cell.ts";
import { isUnavailable } from "@commonfabric/data-model/availability";
import { readAvailabilityAwareCell } from "../data-unavailability.ts";

import { type Action } from "../scheduler.ts";
import { type Runtime } from "../runtime.ts";
import { readsTruthyAtRoot } from "../schema.ts";
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
 *
 * Truthiness is read from the condition's root (`readsTruthyAtRoot()`), so
 * nothing below the root of a condition that is a record or an array is read.
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
    const condition = readAvailabilityAwareCell(tx, conditionCell, {
      surfaceReplicaSyncing: true,
      readValue: false,
    });
    if (isUnavailable(condition)) {
      resultWithLog.setRaw(condition);
      return;
    }
    const inputsWithLog = inputsCell.withTx(tx);

    const truthy = readsTruthyAtRoot(
      runtime,
      tx,
      conditionCell.getAsNormalizedFullLink(),
    );

    // || semantics: if truthy, return condition; if falsy, return fallback
    const ref = truthy
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
