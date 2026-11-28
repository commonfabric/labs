import {
  type Cell,
  sendEvent,
  transactionFailureMessage,
} from "@commonfabric/runner";

/**
 * Sends `event` to `stream`, and resolves once the handler's run on it has
 * committed; rejects when that run fails.
 *
 * Under server execution the serving runtime runs the handler, and this
 * runtime runs no speculative echo of it, so the send starts nothing here: a
 * client that replicates views never has to load the code of the piece that
 * owns `stream`. The promise then settles on the served handling, once it has
 * consequenced (`docs/specs/server-side-execution/events.md`, §4). A runtime
 * that runs its own events runs the handler and settles on that run's commit.
 */
export function sendHandled(
  stream: Cell<unknown>,
  event: unknown,
): Promise<void> {
  return new Promise<void>((resolve, reject) =>
    sendEvent(stream, event, (tx) => {
      const status = tx.status();
      if (status.status === "error") {
        reject(new Error(transactionFailureMessage(status.error)));
      } else resolve();
    }, { echo: false })
  );
}
