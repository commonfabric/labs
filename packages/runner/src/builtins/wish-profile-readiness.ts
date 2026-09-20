/** Confirms missing profile-resolution documents before Wish chooses a branch. */

import { type Cell, syncCellForIdentity } from "../cell.ts";
import type { Runtime } from "../runtime.ts";
import type { Action } from "../scheduler.ts";
import { entityKey } from "../scheduler/keys.ts";
import type {
  IExtendedStorageTransaction,
  IStorageNotification,
} from "../storage/interface.ts";

/** A profile-resolution read whose backing document is still loading. */
export class WishProfilePending extends Error {}

/** A document confirmation's pending, completed, or failed outcome. */
type Confirmation =
  | { status: "pending" }
  | { status: "confirmed" }
  | { status: "failed"; error: Error };

/**
 * Holds missing-document reads until synchronization establishes presence or
 * absence. Completion re-arms the registered Wish even when storage writes
 * nothing; cancellation and replica reset retire outstanding confirmations.
 */
export function createWishProfileReadiness(
  runtime: Runtime,
  addCancel: (cancel: () => void) => void,
) {
  const confirmations = new Map<string, Confirmation>();
  let active = true;
  let subscribed = false;
  let action: Action | undefined;
  const subscription: IStorageNotification = {
    next(notification) {
      if (!active) return { done: true };
      if (notification.type === "reset") {
        confirmations.clear();
        if (action) {
          runtime.scheduler.invalidateAction(action, { retry: true });
        }
      }
      return undefined;
    },
  };
  addCancel(() => {
    active = false;
    confirmations.clear();
    if (subscribed) runtime.storageManager.unsubscribe?.(subscription);
  });

  return {
    /** Records the scheduler wrapper that owns this Wish's subscription. */
    onActionRegistered(registered: Action): void {
      action = registered;
    },
    /**
     * Returns document presence. Throws `WishProfilePending` while loading and
     * the confirmation's error if loading fails.
     */
    requireDocument(
      cell: Cell<unknown>,
      tx: IExtendedStorageTransaction,
    ): boolean {
      const link = cell.getAsNormalizedFullLink();
      const address = { ...link, path: [] };
      const document = tx.readOrThrow(address, {
        nonRecursive: true,
      });
      if (document !== undefined) return true;

      const identity = tx.tx.scopeKeyIdentity;
      const key = entityKey(address, identity ?? runtime.scopeKeyIdentity);
      const prior = confirmations.get(key);
      if (prior?.status === "confirmed") return false;
      if (prior?.status === "failed") throw prior.error;
      if (prior === undefined) {
        if (!subscribed) {
          runtime.storageManager.subscribe(subscription);
          subscribed = true;
        }
        const confirmation: Confirmation = { status: "pending" };
        confirmations.set(key, confirmation);
        const root = runtime.getCellFromLink({
          ...link,
          path: [],
          schema: { type: "unknown" },
        });
        const finish = (next: Confirmation): void => {
          if (!active || confirmations.get(key) !== confirmation) return;
          confirmations.set(key, next);
          if (action) {
            runtime.scheduler.invalidateAction(action, { retry: true });
          }
        };
        // syncCell registers its pending load before yielding, but can fulfill
        // with a provider error. Captures the ledger's failure-aware wait before
        // that load settles and its ledger entry is removed.
        const sync = syncCellForIdentity(root, identity);
        const settled = runtime.storageManager.loadsSettled?.([key]);
        runtime.storageManager.trackUntilSettled(
          Promise.all([sync, settled]).then(
            () => finish({ status: "confirmed" }),
            (cause: unknown) =>
              finish({
                status: "failed",
                error: new Error("Could not load profile selection data", {
                  cause,
                }),
              }),
          ),
        );
      }
      throw new WishProfilePending();
    },
  };
}
