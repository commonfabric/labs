/**
 * A transaction that has settled releases its preparation, so its prepare
 * status reads `unprepared` afterwards whatever the commit prepared. A test
 * of what a commit prepared reads the status at settlement instead, where a
 * commit callback sees it.
 */

import type { CfcPrepareState } from "../src/cfc/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

/**
 * Registers a commit callback on `tx` and returns a function returning the
 * prepare status `tx` held when it settled, or `undefined` while it has not.
 */
export function prepareStatusAtSettlement(
  tx: IExtendedStorageTransaction,
): () => CfcPrepareState["status"] | undefined {
  let status: CfcPrepareState["status"] | undefined;
  tx.addCommitCallback((settled) => {
    status = settled.getCfcState().prepare.status;
  });
  return () => status;
}
