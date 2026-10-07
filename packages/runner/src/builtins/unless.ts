import { type Cell } from "../cell.ts";
import type { RawNodeCause } from "../module.ts";
import { type Runtime } from "../runtime.ts";
import { type Action } from "../scheduler.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { forwardReferenceAction } from "./forward-reference.ts";

/**
 * `unless(condition, fallback)`, the `||` of a pattern: forwards a reference
 * to the condition when it is truthy, and to `fallback` otherwise.
 * An unavailable condition propagates its native marker without selecting
 * either input.
 */
export function unless(
  inputsCell: Cell<{ condition: any; fallback: any }>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: RawNodeCause,
  parentCell: Cell<any>,
  runtime: Runtime,
): Action {
  return forwardReferenceAction({
    name: "unless",
    inputsCell,
    sendResult,
    cause,
    parentCell,
    runtime,
    select: (truthy) => truthy ? "condition" : "fallback",
  });
}
