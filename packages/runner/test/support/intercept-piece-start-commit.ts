/**
 * Holding back or refusing the commit a piece start makes of its graph's setup
 * writes, for a test of whatever learns that commit's outcome. `start()`
 * resolves before the commit settles, so only a test that controls the
 * settlement can tell a caller that waited for it from one that did not.
 */

import type { Runtime } from "../../src/runtime.ts";
import { createTransactionCommitReceipt } from "../../src/storage/commit-receipt.ts";
import type {
  CommitError,
  IStorageTransactionAborted,
} from "../../src/storage/interface.ts";
import type { RuntimeTelemetryEvent } from "../../src/telemetry.ts";

/**
 * Storage's refusal of a commit in the shape it reports one, a result error
 * rather than an `Error`, with `message` as its reason.
 */
export function commitRefusal(message: string): IStorageTransactionAborted {
  return {
    name: "StorageTransactionAborted",
    message,
    reason: new Error(message),
  };
}

/**
 * Intercepts the commit of the next piece start's own transaction, letting
 * every other transaction commit as it would. Installing a piece opens read
 * transactions it never commits, so the start's own is the first transaction
 * committed after the runner announces the install.
 *
 * With `refusal`, the commit is refused with it, and applies nothing: the
 * transaction is aborted the way a server refusal discards its writes. With
 * `held`, the commit's settlement waits for `release()`. `restore()` releases
 * it and stops intercepting.
 */
export function interceptPieceStartCommit(
  runtime: Runtime,
  options: { refusal?: CommitError; held?: boolean } = {},
): { release(): void; restore(): void } {
  const gate = Promise.withResolvers<void>();
  if (!options.held) gate.resolve();
  const edit = runtime.edit.bind(runtime);
  let intercepting = false;
  const onInstall = (event: Event) => {
    const { marker } = (event as RuntimeTelemetryEvent).detail;
    if (marker.type !== "runner.piece.install") return;
    runtime.telemetry.removeEventListener("telemetry", onInstall);
    intercepting = true;
    runtime.edit = (editOptions) => {
      const tx = edit(editOptions);
      const commit = tx.commit.bind(tx);
      tx.commit = (commitOptions) => {
        if (!intercepting) return commit(commitOptions);
        intercepting = false;
        runtime.edit = edit;
        const { refusal } = options;
        if (refusal !== undefined) {
          tx.abort(refusal.message);
          return createTransactionCommitReceipt(
            gate.promise.then(() => ({ error: refusal })),
          );
        }
        const receipt = commit(commitOptions);
        return createTransactionCommitReceipt(
          gate.promise.then(() => receipt.settled),
        );
      };
      return tx;
    };
  };
  runtime.telemetry.addEventListener("telemetry", onInstall);
  return {
    release: () => gate.resolve(),
    restore: () => {
      gate.resolve();
      runtime.telemetry.removeEventListener("telemetry", onInstall);
      runtime.edit = edit;
    },
  };
}
