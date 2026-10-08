import { type Cell } from "../cell.ts";
import type { RawNodeCause } from "../module.ts";
import { type Runtime } from "../runtime.ts";
import { type Action } from "../scheduler.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { forwardReferenceAction } from "./forward-reference.ts";

/**
 * `when(condition, value)`, the `&&` of a pattern: forwards a reference to
 * `value` when the condition is truthy, and to the condition otherwise.
 */
export function when(
  inputsCell: Cell<{ condition: any; value: any }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: RawNodeCause,
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  return forwardReferenceAction({
    name: "when",
    inputsCell,
    sendResult,
    cause,
    parentCell,
    runtime,
    select: (truthy) => truthy ? "value" : "condition",
  });
}
