/** Confirms document availability for runtime-owned reactive actions. */

import type { ScopeKeyIdentity } from "@commonfabric/memory/v2";

import { type Cell, syncCellForIdentity } from "./cell.ts";
import type { Runtime } from "./runtime.ts";
import type { Action } from "./scheduler.ts";
import { entityKey } from "./scheduler/keys.ts";
import { txToReactivityLog } from "./scheduler/reactivity.ts";
import type {
  IExtendedStorageTransaction,
  IStorageNotification,
} from "./storage/interface.ts";

/** A runtime read whose backing document is still loading. */
export class DocumentPending extends Error {}

/** A document synchronization failure, distinct from pending or absent data. */
export class DocumentLoadError extends Error {}

/**
 * Loads the root document `root` names, under `identity`'s scope key when one
 * is given, and settles once the load has. Rejects with a
 * {@link DocumentLoadError} when the load fails: a provider reports a failed
 * load in its result, which the sync alone resolves through, so the failure
 * is read from the storage manager's ledger of loads, captured before the
 * load settles.
 */
function documentLoad(
  runtime: Runtime,
  root: Cell<unknown>,
  identity: ScopeKeyIdentity | undefined,
): Promise<void> {
  const { space, id, scope } = root.getAsNormalizedFullLink();
  const key = entityKey(
    { space, id, scope },
    identity ?? runtime.scopeKeyIdentity,
  );
  const sync = syncCellForIdentity(root, identity);
  const settled = runtime.storageManager.loadsSettled?.([key]);
  return Promise.all([sync, settled]).then(
    () => undefined,
    (cause: unknown) => {
      throw new DocumentLoadError("Could not load document", { cause });
    },
  );
}

/**
 * Loads the document `cell` names and returns whether it is present: `false`
 * when it is confirmed absent. Rejects with a {@link DocumentLoadError} when
 * the load fails, rather than returning `false` as a plain `Cell.sync()`
 * followed by a read would.
 */
export async function loadDocument(
  runtime: Runtime,
  cell: Cell<unknown>,
): Promise<boolean> {
  const root = runtime.getCellFromLink({
    ...cell.getAsNormalizedFullLink(),
    path: [],
    schema: { type: "unknown" },
  });
  await documentLoad(runtime, root, undefined);
  return root.getRaw() !== undefined;
}

/**
 * A document confirmation's pending, completed, or failed outcome. A pending
 * one holds the scope identity of each read waiting on it, `undefined` for a
 * read that carries none.
 */
type Confirmation =
  | { status: "pending"; waiters: Set<ScopeKeyIdentity | undefined> }
  | { status: "confirmed" }
  | { status: "failed"; error: DocumentLoadError };

/**
 * Holds missing-document reads until synchronization establishes presence or
 * absence. Completion re-arms the registered action even when storage writes
 * nothing; cancellation and replica reset retire outstanding confirmations.
 * On a fanned-out action, completion re-arms only the instances whose reads
 * waited on the document, so their siblings stay current.
 */
export function createDocumentReadiness(
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
    /** Records the scheduler wrapper that owns this readiness subscription. */
    onActionRegistered(registered: Action): void {
      action = registered;
    },
    /**
     * Gates loads reached while reading linked fields or schemas. Uses the
     * transaction's read set so unrelated background loads cannot park an
     * action. Completed failures remain visible until their data arrives.
     * `optionalDocuments` exempts only their completed load failures; pending
     * loads still park the action.
     */
    requireLoadedReads(
      tx: IExtendedStorageTransaction,
      optionalDocuments: Iterable<Cell<unknown>> = [],
    ): void {
      const identity = tx.tx.scopeKeyIdentity ?? runtime.scopeKeyIdentity;
      const pending = new Set(
        (runtime.storageManager.pendingLoadAddresses?.() ?? [])
          .map((address) => entityKey(address, identity)),
      );
      if (pending.size === 0 && confirmations.size === 0) return;
      const optional = new Set(
        Array.from(
          optionalDocuments,
          (cell) => entityKey(cell.getAsNormalizedFullLink(), identity),
        ),
      );
      const log = txToReactivityLog(tx);
      const checked = new Set<string>();
      for (const read of [...log.reads, ...log.shallowReads]) {
        const key = entityKey(read, identity);
        if (checked.has(key)) continue;
        checked.add(key);
        if (!pending.has(key) && !confirmations.has(key)) continue;
        if (optional.has(key) && confirmations.get(key)?.status === "failed") {
          continue;
        }
        this.requireDocument(
          runtime.getCellFromLink({
            ...read,
            path: [],
            schema: { type: "unknown" },
          }),
          tx,
        );
      }
    },
    /**
     * Returns document presence. Throws `DocumentPending` while loading and
     * `DocumentLoadError` if loading fails.
     */
    requireDocument(
      cell: Cell<unknown>,
      tx: IExtendedStorageTransaction,
    ): boolean {
      const link = cell.getAsNormalizedFullLink();
      const address = { ...link, path: [] };
      const identity = tx.tx.scopeKeyIdentity;
      const key = entityKey(address, identity ?? runtime.scopeKeyIdentity);
      const document = tx.readOrThrow(address, {
        nonRecursive: true,
      });
      if (document !== undefined) {
        // Presence supersedes both completed and in-flight confirmations.
        confirmations.delete(key);
        return true;
      }

      const prior = confirmations.get(key);
      if (prior?.status === "confirmed") return false;
      if (prior?.status === "failed") throw prior.error;
      if (prior?.status === "pending") prior.waiters.add(identity);
      if (prior === undefined) {
        if (!subscribed) {
          runtime.storageManager.subscribe(subscription);
          subscribed = true;
        }
        const confirmation: Confirmation = {
          status: "pending",
          waiters: new Set([identity]),
        };
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
            // A waiter with no scope identity read as the whole action, so
            // every instance runs again.
            const instances = [...confirmation.waiters].filter((
              waiter,
            ): waiter is ScopeKeyIdentity => waiter !== undefined);
            runtime.scheduler.invalidateAction(action, {
              retry: true,
              ...(instances.length === confirmation.waiters.size
                ? { instances }
                : {}),
            });
          }
        };
        // syncCell registers its pending load before yielding, but can fulfill
        // with a provider error, which `documentLoad()` reads from the ledger.
        runtime.storageManager.trackUntilSettled(
          documentLoad(runtime, root, identity).then(
            () => finish({ status: "confirmed" }),
            (error: DocumentLoadError) => finish({ status: "failed", error }),
          ),
        );
      }
      throw new DocumentPending();
    },
  };
}
