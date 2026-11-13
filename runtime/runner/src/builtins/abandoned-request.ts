import { getLogger } from "@commonfabric/logger";
import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";

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
 * The transaction is attributed to the builtin and carries `identity`, the
 * scope-key identity of the run that staged the request, so its scoped writes
 * land in that run's instance of the cells. How it commits depends on where it
 * runs:
 *
 * - Under the serving posture, it is stamped as a `bookkeeping` run and seals
 *   into the open wave, like the run that staged the request
 *   (serving-loop.md §3d). The cells the ending overwrites may still hold that
 *   run's own writes, pending in the same wave; sealing behind them is what
 *   keeps the ending in front of them, in the serving runtime's view as well as
 *   in the store. Without an identity there is no instance to write to: the
 *   wave would resolve the cells against the service's own session, so the
 *   ending is not written, and the cells keep what the run left.
 * - Everywhere else, it commits on its own, marked with the request's effect
 *   key as a completion of it.
 *
 * Every request staged on the outbox has an effect key, so it is required
 * rather than defaulted.
 */
export async function settleAbandonedRequest(
  runtime: Runtime,
  builtinId: string,
  effectKey: string,
  identity: ScopeKeyIdentity | undefined,
  write: (tx: IExtendedStorageTransaction) => void,
): Promise<void> {
  if (runtime.servingPosture && identity === undefined) {
    console.error(
      `[${builtinId}] The abandoned request's error was not written to its ` +
        `result cells: the run that staged it carried no scope-key identity.`,
      { effectKey },
    );
    logger.warn("builtins", "abandoned-request writeback has no identity", {
      builtinId,
      effectKey,
    });
    return;
  }
  const { error } = await runtime.editWithRetry((tx) => {
    if (runtime.cfcEnforcementMode !== "disabled") {
      setCfcImplementationIdentity(tx, { kind: "builtin", builtinId });
    }
    // Set here as well as by the stamp, which leaves it unset where no serving
    // loop has installed a stamper.
    if (identity !== undefined) tx.tx.scopeKeyIdentity = identity;
    // Under the serving posture `identity` is always present here, since the
    // case without one returned above.
    if (runtime.servingPosture && identity !== undefined) {
      runtime.stampServerRun(tx, {
        actionId: `${builtinId}/abandoned/${effectKey}`,
        kind: "bookkeeping",
        scopeKeyIdentity: identity,
      });
    } else {
      markEffectCompletion(tx, effectKey);
    }
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
