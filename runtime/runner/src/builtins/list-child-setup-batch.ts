/** Coordinates dependency loading for the children of one list reconcile. */

import { RetryImmediately } from "../scheduler/retry-immediately.ts";

/**
 * Collects child dependency loads for one list reconcile. A cold batch must
 * finish loading before it asks for a fresh transaction: retrying after each
 * child would consume the scheduler's retry budget in proportion to list size.
 */
export function listChildSetupBatch(): {
  /** Observes one load's rejection immediately, including on an aborted pass. */
  add(load: Promise<never>): void;

  /** Waits for every load, then throws a load failure or the retry signal. */
  retry(): Promise<never> | undefined;
} {
  // runInTransaction's asynchronous branch always rejects: either dependency
  // loading failed or it requests a fresh transaction with RetryImmediately.
  // Observe each rejection as soon as it starts, even if a later child throws
  // synchronously and the reconcile never reaches retry().
  const pending: Promise<{ reason: unknown }>[] = [];
  return {
    add(load) {
      pending.push(load.catch((reason: unknown) => ({ reason })));
    },
    retry() {
      if (pending.length === 0) return undefined;
      return Promise.all(pending).then((outcomes) => {
        // Every load has settled. A real failure takes precedence over the
        // retry signals; one ready child must not hide a failed sibling.
        const failure = outcomes.find(({ reason }) =>
          !(reason instanceof RetryImmediately)
        );
        throw (failure ?? outcomes[0]).reason;
      });
    },
  };
}
