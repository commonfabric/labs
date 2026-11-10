/**
 * Sends a write again after its memory connection lost it: the half of
 * "connected or connecting" the runner owns, since the memory client keeps
 * nothing for a later connection.
 */

import * as MemoryV2Client from "@commonfabric/memory/v2/client";

/**
 * How many times a commit is sent again after its own payload failed the
 * write (a `ConnectionError` marked `ownWriteFailed`) before it fails with
 * that error: a payload that fails every time would otherwise take each new
 * connection down with it.
 */
export const MAX_OWN_WRITE_FAILURES = 5;

/**
 * Calls `attempt`, a request to the memory client, until it settles with
 * something other than a lost connection. The client keeps nothing for a later
 * connection: a request its connection lost, before it was handed over or
 * after, fails with a `ConnectionError` saying which, and its `readyToRetry()`
 * says when the session can take it again; this makes it again then. A caller
 * whose request must apply once makes it again unchanged, as a commit under
 * its own `localSeq` is, which the server answers from its record if it
 * landed. A request whose own payload failed the write `MAX_OWN_WRITE_FAILURES`
 * times fails with the write's own error (`ownWriteErrorOf()`); one whose session closed, or was replaced,
 * fails as `readyToRetry()` does.
 */
export async function untilAnswered<T>(attempt: () => Promise<T>): Promise<T> {
  let ownWriteFailures = 0;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (MemoryV2Client.connectionDeliveryOf(error) === undefined) throw error;
      if (
        error instanceof Error && "ownWriteFailed" in error &&
        error.ownWriteFailed === true &&
        ++ownWriteFailures >= MAX_OWN_WRITE_FAILURES
      ) throw ownWriteErrorOf(error);
      if (
        !(error instanceof Error) || !("readyToRetry" in error) ||
        typeof error.readyToRetry !== "function"
      ) throw error;
      await error.readyToRetry();
    }
  }
}

/**
 * The error a request whose own write failed `MAX_OWN_WRITE_FAILURES` times
 * fails with: the write's own error, found under the `ConnectionError`s that
 * carried it, rather than a `ConnectionError`, which a caller would retry.
 */
const ownWriteErrorOf = (error: Error): Error => {
  let cause: unknown = error.cause;
  while (cause instanceof Error && cause.name === "ConnectionError") {
    cause = cause.cause;
  }
  return cause instanceof Error
    ? cause
    : new Error(error.message, { cause: error.cause });
};
