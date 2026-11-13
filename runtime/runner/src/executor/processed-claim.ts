/**
 * A served event's processed claim: what the serving loop writes on the
 * event's entry, in the transaction that runs the event's handler, to record
 * that the event has been handled.
 *
 * §6.2.2 claims the processed cell apart from the handler, before it runs, so
 * the claim reads none of what the handler reads and says the same thing
 * whatever the handler then does. Writing it in the handler's own transaction,
 * so that it commits with the consequences, keeps both: each path the claim
 * writes is named for the prepare gate, which leaves it out of the handler's
 * join, and under a join the stream's space doesn't admit the claim records
 * `withheld` in place of how the handling ended
 * (https://github.com/commonfabric/specs/pull/94).
 */

import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  endedRunReadForeignLabel,
  processedClaimJoinIsForeign,
} from "../cfc/prepare.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_PROCESSED_CLAIM,
  runtimeWritePolicyAuthorization,
} from "../cfc/types.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { getTransactionReadActivities } from "../storage/transaction-inspection.ts";

/** Where an event's entry sits: its stream's entries document, and its index. */
export interface ProcessedClaimEntry {
  /** The id of the stream's entries document. */
  sidecarId: string;

  /** The entry's index in the document's `entries`. */
  index: number;
}

/**
 * The served runs whose join `withholdProcessedClaimOutcome()` found foreign
 * and whose claim the wave writes, keyed on the run's transaction, which the
 * wave seals.
 */
const withheldWaveClaims = new WeakSet<IExtendedStorageTransaction>();

/**
 * Writes `value` at the field `field` of `entry` in `space` on `tx`, naming
 * the path a processed claim for the prepare gate.
 */
const writeClaimField = (
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  entry: ProcessedClaimEntry,
  field: string,
  value: boolean | undefined,
): void => {
  const path = ["entries", String(entry.index), field];
  tx.recordCfcWritePolicyInput({
    kind: "structural-provenance",
    target: { space, id: entry.sidecarId, scope: "space", path },
    claim: CFC_STRUCTURAL_PROVENANCE_PROCESSED_CLAIM,
    sources: [],
  }, runtimeWritePolicyAuthorization);
  runtime.getCellFromLink<boolean | undefined>({
    space,
    id: entry.sidecarId as never,
    scope: "space",
    path,
  }).withTx(tx).set(value);
};

/**
 * Writes, on `tx`, the processed claim of the entry `entry` names in `space`:
 * its `consequenced` mark, and, when `clearDeferral` is set, the removal of
 * the delivery deferral recorded on it.
 */
export const writeProcessedClaim = (
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  entry: ProcessedClaimEntry,
  { clearDeferral }: { clearDeferral: boolean },
): void => {
  writeClaimField(runtime, tx, space, entry, "consequenced", true);
  if (clearDeferral) {
    writeClaimField(runtime, tx, space, entry, "deliveryDeferral", undefined);
  }
};

/**
 * Writes, on `tx`, `withheld` on the entry `entry` names in `space`, beside the
 * processed claim's mark: the outcome recorded under a foreign join, in place
 * of how the handling ended.
 */
export const writeWithheldOutcome = (
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  entry: ProcessedClaimEntry,
): void => writeClaimField(runtime, tx, space, entry, "withheld", true);

/**
 * Whether the outcome of the served event-handler run `tx`, whose event's
 * stream lives in `space`, is withheld: whether its join carries a clause the
 * stream's space doesn't admit (`processedClaimJoinIsForeign()`). A run whose
 * transaction has already ended, as one the handler aborted has, no longer
 * holds the label observations its join is derived from. For it, the reads it
 * journaled are weighed instead, through a transaction of its own
 * (`endedRunReadForeignLabel()`): a document of another space, or one of the
 * stream's own space labeled outside it, makes it foreign, which withholds
 * more rather than less. Where neither can be decided, it is withheld.
 */
export const runOutcomeIsWithheld = (
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
): boolean => {
  if (tx.status().status === "ready") {
    try {
      return processedClaimJoinIsForeign(tx, space);
    } catch {
      // Fall through to what the run's reads say.
    }
  }
  const reader = runtime.edit();
  try {
    return endedRunReadForeignLabel(
      reader,
      getTransactionReadActivities(tx),
      space,
    );
  } catch {
    return true;
  } finally {
    reader.abort();
  }
};

/**
 * Decides, for the served event-handler run `tx` whose event's stream lives in
 * `space`, whether its processed claim withholds the outcome: whether the
 * run's join carries a clause the stream's space doesn't admit
 * (`runOutcomeIsWithheld()`). When it does, a run delivered from its
 * event's durable entry (`entry`) records `withheld` on that entry beside the
 * mark, in its own transaction, and a run the wave delivers beside its event's
 * append is noted for the wave to record it (`waveClaimIsWithheld()`). Returns
 * the decision, which a failure arm reports the same way.
 */
export const withholdProcessedClaimOutcome = (
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  entry: ProcessedClaimEntry | undefined,
): boolean => {
  if (!runOutcomeIsWithheld(runtime, tx, space)) return false;
  if (tx.status().status !== "ready") return true;
  if (entry === undefined) {
    withheldWaveClaims.add(tx);
  } else {
    writeWithheldOutcome(runtime, tx, space, entry);
  }
  return true;
};

/**
 * Whether the wave is to record the processed claim it writes for the run
 * `tx` as withheld (see `withholdProcessedClaimOutcome()`).
 */
export const waveClaimIsWithheld = (
  tx: IExtendedStorageTransaction,
): boolean => withheldWaveClaims.has(tx);
