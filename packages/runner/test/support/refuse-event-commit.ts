/**
 * Refusing an event handler's commit the way a server refuses one on a stale
 * basis, for a test that needs the scheduler to re-run a handler for the same
 * event.
 */

import type { Runtime } from "../../src/runtime.ts";
import type { CommitError, MemorySpace } from "../../src/storage/interface.ts";

/**
 * The stale-basis refusal in the shape `toRejectedError` hands the
 * scheduler: the engine's message plus the conflict descriptor parsed from
 * it, and the catch-up gate the wire attaches. It names the REAL document
 * the handler writes, so the readiness pull resolves against the store
 * rather than a phantom id.
 */
export function staleReadRefusal(
  space: MemorySpace,
  of: string,
  readyToRetry: () => Promise<void>,
): CommitError {
  return {
    name: "ConflictError",
    message: `stale confirmed read: ${of} at seq 0 conflicted with seq 9`,
    conflict: { space, the: "application/json", of },
    readyToRetry,
  } as unknown as CommitError;
}

/**
 * Refuses the first commit of an event handler's transaction with
 * `refusal`, letting every other transaction commit as it would. The
 * handler's transaction is the one the scheduler stamps with a dispatched
 * event id before running the handler. A refused commit applies nothing,
 * so the attempt's writes are discarded the way the rollback behind a
 * server refusal discards them.
 */
export function refuseFirstEventCommit(
  runtime: Runtime,
  refusal: CommitError,
): { refusals(): number; restore(): void } {
  const edit = runtime.edit.bind(runtime);
  let refusals = 0;
  runtime.edit = (options) => {
    const tx = edit(options);
    const commit = tx.commit.bind(tx);
    tx.commit = (commitOptions) => {
      if (tx.dispatchedEventId === undefined || refusals > 0) {
        return commit(commitOptions);
      }
      refusals++;
      tx.abort(refusal.message);
      return Promise.resolve({ error: refusal });
    };
    return tx;
  };
  return {
    refusals: () => refusals,
    restore: () => {
      runtime.edit = edit;
    },
  };
}
