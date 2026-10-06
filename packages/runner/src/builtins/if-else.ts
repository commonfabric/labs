import { internSchema } from "@commonfabric/data-model-schema";

import { type Cell } from "../cell.ts";
import { type RawBuiltinResult, type RawNodeCause } from "../module.ts";
import { type Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { forwardReferenceAction } from "./forward-reference.ts";

/**
 * Argument schema for ifElse. The action value-reads ONLY `condition`; the
 * `ifTrue`/`ifFalse` branches are pass-through references — the action resolves
 * a LINK to the selected branch and forwards it, never reading the branch
 * VALUE. Marking the branches `asCell: ["opaque"]` lets the runner drop those
 * keys from this node's declared reads (via `opaqueArgumentKeys` +
 * `findAllWriteRedirectCells`'s `skipTopLevelKeys`), so the (possibly
 * unselected) branch writer is no longer pulled at settle. The selected branch
 * is still scheduled by the DOWNSTREAM reader of ifElse's result (it follows
 * the result link and demands the branch's value), independent of ifElse's own
 * declared reads.
 *
 * `condition` stays a plain (value-read) input, so a condition change keeps
 * re-running ifElse. The action decides on its truthiness alone, which it reads
 * from the condition's root (`readsTruthyAtRoot()`), so nothing below the root
 * of a condition that is a record or an array is read.
 */
export const IF_ELSE_ARGUMENT_SCHEMA = internSchema({
  type: "object",
  properties: {
    condition: { type: "unknown" },
    ifTrue: { type: "unknown", asCell: ["opaque"] },
    ifFalse: { type: "unknown", asCell: ["opaque"] },
  },
});

/**
 * `ifElse(condition, ifTrue, ifFalse)`: forwards a reference to `ifTrue` when
 * the condition is truthy, and to `ifFalse` otherwise.
 */
export function ifElse(
  inputsCell: Cell<[any, any, any]>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  _addCancel: (cancel: () => void) => void,
  cause: RawNodeCause,
  parentCell: Cell<any>,
  runtime: Runtime, // Runtime will be injected by the registration function
): RawBuiltinResult {
  return {
    action: forwardReferenceAction({
      name: "ifElse",
      inputsCell,
      sendResult,
      cause,
      parentCell,
      runtime,
      select: (truthy) => truthy ? "ifTrue" : "ifFalse",
    }),
  };
}
