import type { Runtime } from "./runtime.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";

/**
 * Returns a commit sequence by which the handling of a sent event had
 * committed in its receipt's space, given the transaction a sender's commit
 * callback received, or `undefined` when that handling wrote no receipt.
 *
 * The sequence is a position in the space's commit log, comparable with the
 * `since` of any document read from that space and with `committedSeq` on any
 * transaction committed there. It is exact when the callback's transaction
 * committed the handling: that transaction's own `committedSeq`. Otherwise —
 * a `receipt-exists` collision, which addresses an earlier delivery's
 * handling, or server execution, where the callback receives the sender's
 * local echo — it is the current revision of the handling's receipt. The
 * handling's commit created the receipt, so that revision never names an
 * earlier commit, but a later write to the receipt names a later one: a
 * handler whose result is reactive launches a pattern whose result cell is
 * the receipt, and that pattern goes on writing it. The sequence is therefore
 * a bound for a barrier, at or past which a read reflects the handling, and
 * not an identity to compare commits by.
 *
 * A receipt is written only with commit preconditions or server execution
 * enabled (`IExtendedStorageTransaction.handlingReceiptLink`). Call it once
 * the callback has fired: under server execution that is after the served
 * handling consequenced, and before it the receipt does not exist.
 */
export async function handlingCommittedBy(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
): Promise<number | undefined> {
  const receipt = tx.handlingReceiptLink;
  if (receipt === undefined) return undefined;
  // A handling this transaction committed names itself; the receipt is read
  // only for one committed elsewhere.
  const committed = tx.committedSeq?.(receipt.space);
  if (committed !== undefined) return committed;
  await runtime.getCellFromLink(receipt).sync();
  const since = runtime.storageManager.open(receipt.space).replica.get({
    id: receipt.id,
    scope: receipt.scope,
  })?.since;
  return since === undefined || since === 0 ? undefined : since;
}
