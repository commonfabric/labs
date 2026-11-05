import type { Cell } from "../cell.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { setResultCell } from "../result-utils.ts";
import type {
  ListSetupRollback,
  SetupRecord,
} from "./list-element-rollback.ts";

/**
 * Issue the writes that make a list coordinator's result container reachable:
 * the container's `result` meta and the link the coordinator hands to its
 * output binding.
 *
 * A coordinator mints a container and then keeps it in memory across reconciles,
 * so these writes are setup in the same sense an element's pattern run is: the
 * reconcile that stages them and does not commit loses them while the
 * coordinator carries on holding the container. A container nothing links to
 * reads as undefined for as long as the coordinator lives, so the record passed
 * here says whether they are owed, and the next reconcile issues them again
 * against the container already in hand. See list-element-rollback.ts for the
 * undo contract.
 */
export function issueResultContainerSetup(
  tx: IExtendedStorageTransaction,
  container: Cell<any>,
  parentCell: Cell<any>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  rollback: ListSetupRollback,
  setup: SetupRecord,
): void {
  setResultCell(container, parentCell);
  sendResult(tx, container);
  rollback.setupIssued(setup);
}
