import { getLogger } from "@commonfabric/logger";
import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";

import type { CellScope } from "../builder/types.ts";
import { markEffectCompletion } from "../executor/effect-completion.ts";
import type { Runtime } from "../runtime.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { setCfcImplementationIdentity } from "../storage/extended-storage-transaction.ts";

const logger = getLogger("builtins", { enabled: true, level: "warn" });

/** The request an ending belongs to, and how its transaction is attributed. */
export type AbandonedRequest = {
  builtinId: string;

  /** The request's effect key, which every request staged on the outbox has. */
  effectKey: string;

  /**
   * The scope-key identity of the run that staged the request, when that run
   * carried one. A served run that nobody demands carries none.
   */
  identity: ScopeKeyIdentity | undefined;

  /** The scope of the result cells the ending writes. */
  scope: CellScope;

  /**
   * Whether the ending's transaction is attributed to the builtin as its
   * implementation, when CFC enforcement is on.
   */
  attributeToBuiltin: boolean;

  /**
   * Reports the ending's own write being rejected. Without one, the helper
   * reports it, naming the builtin.
   */
  reportRejection?: (rejection: Error) => void;
};

/**
 * Write the ending of a request that will never be sent: its staging
 * transaction was abandoned, or the request was dropped after that transaction
 * committed.
 *
 * Nothing else will say that the request is not going out. `write` puts that
 * on the builtin's own result cells — the pending flag down, the refusal as the
 * error — and announces those cells again, because the announcement rode the
 * abandoned transaction and a reader has nothing to look at without it. The
 * transaction carries `request.identity`, so its scoped writes land in that
 * run's instance of the cells.
 *
 * How it commits depends on where it runs:
 *
 * - Under the serving posture, when the run that staged the request has
 *   sealed, the serving loop holds that run's identity carriage, and the ending
 *   commits as a completion of the request under it, like any other
 *   completion (serving-loop.md §4).
 * - Under the serving posture, when that run never sealed, there is no
 *   carriage. The ending is stamped as a `bookkeeping` run and seals into the
 *   open wave (serving-loop.md §3d). The cells it overwrites may still hold an
 *   earlier run's writes, pending in that wave; sealing behind them is what
 *   keeps the ending in front of them, in the serving runtime's view as well as
 *   in the store. Without an identity the wave resolves the cells against the
 *   service's own session, which is the one instance a space-scoped cell has,
 *   so the ending is written; for a user- or session-scoped cell it would be
 *   the service's instance rather than the requester's, so the ending is not
 *   written, and the cells keep what the refused run left.
 * - Everywhere else, it commits on its own, marked as a completion of the
 *   request.
 */
export async function settleAbandonedRequest(
  runtime: Runtime,
  request: AbandonedRequest,
  write: (tx: IExtendedStorageTransaction) => void,
): Promise<void> {
  const { builtinId, effectKey, identity } = request;
  const sealed = runtime.servingPosture &&
    runtime.hasServedEffectCarriage(effectKey);
  if (
    runtime.servingPosture && !sealed && identity === undefined &&
    request.scope !== "space"
  ) {
    console.error(
      `[${builtinId}] The abandoned request's error was not written to its ` +
        `${request.scope}-scoped result cells: the run that staged it ` +
        `carried no scope-key identity.`,
      { effectKey },
    );
    logger.warn("builtins", "abandoned-request writeback has no identity", {
      builtinId,
      effectKey,
    });
    return;
  }
  const { error } = await runtime.editWithRetry((tx) => {
    if (
      request.attributeToBuiltin && runtime.cfcEnforcementMode !== "disabled"
    ) {
      setCfcImplementationIdentity(tx, { kind: "builtin", builtinId });
    }
    // Set here as well as by the stamp, which leaves it unset where no serving
    // loop has installed a stamper.
    if (identity !== undefined) tx.tx.scopeKeyIdentity = identity;
    if (runtime.servingPosture && !sealed) {
      runtime.stampServerRun(tx, {
        actionId: `${builtinId}/abandoned/${effectKey}`,
        kind: "bookkeeping",
        ...(identity !== undefined ? { scopeKeyIdentity: identity } : {}),
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
    if (request.reportRejection !== undefined) {
      request.reportRejection(error);
      return;
    }
    console.error(
      `[${builtinId}] Writing the abandoned request's error to its result ` +
        `cells was rejected.`,
      { rejection: error.message },
    );
    logger.warn("builtins", "abandoned-request writeback rejected", { error });
  }
}
