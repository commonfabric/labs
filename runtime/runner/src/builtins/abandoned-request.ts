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
   * The identity the run that staged the request wrote its cells under, so
   * the ending lands in the instance that run wrote. A builtin whose runs fall
   * back to the runtime's own identity passes that fallback; one whose runs
   * carry only a demanded identity passes `undefined` for a served run that
   * nobody demands.
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
 * abandoned transaction and a reader has nothing to look at without it.
 *
 * The ending lands in the instance the staging run itself wrote: the
 * transaction carries `request.identity`, which is that run's. Builtins differ
 * in what that is for a served run nobody demands, and the ending follows the
 * run either way. The `llm` builtins, `compileAndRun` and `agent` act as the
 * runtime's own identity then, so they pass it, and the ending is written in
 * the runtime's instance, where their run wrote. The `fetch*` builtins,
 * `fetchProgram` and `sqliteQuery` carry no identity then, so they pass none.
 *
 * How it commits depends on where it runs:
 *
 * - Under the serving posture, with server execution on, while the request's
 *   work is running: its release check passed, so the serving loop holds the
 *   identity carriage the staging run's seal recorded, and holds it until that
 *   work settles. The ending commits as a completion of the request under it,
 *   like any other completion (serving-loop.md §4). This is a failure inside
 *   the builtin's own post-commit work.
 * - Under the serving posture, with server execution on, otherwise: the
 *   staging run never sealed, or its release check refused the request, whose
 *   carriage then retires as soon as the refusing flush returns. The ending is
 *   stamped as a `bookkeeping` run carrying `request.identity` and seals into
 *   the open wave (serving-loop.md §3d). The cells it overwrites may still hold
 *   an earlier run's writes, pending in that wave; sealing behind them is what
 *   keeps the ending in front of them, in the serving runtime's view as well as
 *   in the store. Without an identity the wave resolves the cells against the
 *   service's own session. For a space-scoped cell that is its one instance,
 *   and the ending is written. For a user- or session-scoped cell there is no
 *   instance the run could be said to have written, so the ending is not
 *   written, and the cells keep what the refused run left.
 * - Everywhere else, a serving runtime with server execution off included, it
 *   commits on its own, marked as a completion of the request, as a client's
 *   does.
 *
 * Which of the first two applies is asked inside the transaction, at each
 * attempt, since the answer can change between the call and the commit.
 */
export async function settleAbandonedRequest(
  runtime: Runtime,
  request: AbandonedRequest,
  write: (tx: IExtendedStorageTransaction) => void,
): Promise<void> {
  const { builtinId, effectKey, identity } = request;
  // A serving loop runs only with server execution on; a serving runtime
  // without it commits every transaction to the store, as a client does.
  const served = runtime.servingPosture &&
    runtime.experimental.serverExecution === true;
  let unwritable = false;
  const { error } = await runtime.editWithRetry((tx) => {
    // Asked at each attempt, the latest point before the commit: the outbox
    // retires a carriage whose request never went out as soon as the flush
    // that refused it returns.
    const completion = served && runtime.hasDispatchedEffectCarriage(effectKey);
    unwritable = served && !completion && identity === undefined &&
      request.scope !== "space";
    if (unwritable) return;
    if (
      request.attributeToBuiltin && runtime.cfcEnforcementMode !== "disabled"
    ) {
      setCfcImplementationIdentity(tx, { kind: "builtin", builtinId });
    }
    // Set here as well as by the stamp, which leaves it unset where no serving
    // loop has installed a stamper.
    if (identity !== undefined) tx.tx.scopeKeyIdentity = identity;
    if (served && !completion) {
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
  if (unwritable) {
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
