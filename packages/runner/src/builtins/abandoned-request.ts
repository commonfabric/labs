import { getLogger } from "@commonfabric/utils/logger";

import { markEffectCompletion } from "../executor/effect-completion.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { setCfcImplementationIdentity } from "../storage/extended-storage-transaction.ts";

const logger = getLogger("builtins", { enabled: true, level: "warn" });

/**
 * Write the ending of a request whose staging transaction was abandoned.
 *
 * A builtin stages its request in the transaction that schedules the work and
 * does the work once that transaction commits, so an abandoned one means the
 * request will never be sent and nothing else will say so. `write` puts that on
 * the builtin's own result cells — the pending flag down, the refusal as the
 * error — and announces those cells again, because the announcement rode the
 * abandoned transaction and a reader has nothing to look at without it.
 *
 * One transaction for both, attributed to the builtin and carrying the served
 * effect's completion key: a writeback naming neither is refused under the
 * serving posture, which would leave the pattern pointing at nothing — the
 * state this exists to prevent. Every request staged on the outbox has such a
 * key, so it is required rather than defaulted.
 */
export async function settleAbandonedRequest(
  runtime: Runtime,
  builtinId: string,
  effectKey: string,
  write: (tx: IExtendedStorageTransaction) => void,
): Promise<void> {
  const { error } = await runtime.editWithRetry((tx) => {
    if (runtime.cfcEnforcementMode !== "disabled") {
      setCfcImplementationIdentity(tx, { kind: "builtin", builtinId });
    }
    markEffectCompletion(tx, effectKey);
    write(tx);
  });
  if (error) {
    // The ending had nowhere to land, so a reader of these cells sees
    // something other than this failure. Report it here, since nothing
    // downstream can.
    console.error(
      `[${builtinId}] Writing the abandoned request's error to its result ` +
        `cells was rejected.`,
      { rejection: error.message },
    );
    logger.warn("builtins", "abandoned-request writeback rejected", { error });
  }
}
