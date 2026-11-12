/**
 * A served event's processed claim: the mark the serving loop writes on the
 * event's entry, in the transaction that runs the event's handler, to record
 * that the event has been handled.
 */

import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  CFC_STRUCTURAL_PROVENANCE_PROCESSED_CLAIM,
  runtimeWritePolicyAuthorization,
} from "../cfc/types.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

/** Where an event's entry sits: its stream's entries document, and its index. */
export interface ProcessedClaimEntry {
  /** The id of the stream's entries document. */
  sidecarId: string;

  /** The entry's index in the document's `entries`. */
  index: number;
}

/**
 * Writes, on `tx`, the processed claim of the entry `entry` names in `space`:
 * its `consequenced` mark, and, when `clearDeferral` is set, the removal of
 * the delivery deferral recorded on it. Each path is named for the prepare
 * gate as a processed claim, which takes nothing of what the handler reads:
 * §6.2.2 claims the processed cell apart from the handler, so the claim reads
 * none of what the handler reads, and writing it in the handler's own
 * transaction, so that it commits with the consequences, leaves it that way.
 */
export const writeProcessedClaim = (
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  entry: ProcessedClaimEntry,
  { clearDeferral }: { clearDeferral: boolean },
): void => {
  const claim = (field: string): string[] => {
    const path = ["entries", String(entry.index), field];
    tx.recordCfcWritePolicyInput({
      kind: "structural-provenance",
      target: { space, id: entry.sidecarId, scope: "space", path },
      claim: CFC_STRUCTURAL_PROVENANCE_PROCESSED_CLAIM,
      sources: [],
    }, runtimeWritePolicyAuthorization);
    return path;
  };
  runtime.getCellFromLink<boolean>({
    space,
    id: entry.sidecarId as never,
    scope: "space",
    path: claim("consequenced"),
  }).withTx(tx).set(true);
  if (clearDeferral) {
    runtime.getCellFromLink<unknown>({
      space,
      id: entry.sidecarId as never,
      scope: "space",
      path: claim("deliveryDeferral"),
    }).withTx(tx).set(undefined);
  }
};
