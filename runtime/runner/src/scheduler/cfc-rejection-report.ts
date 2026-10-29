/**
 * Whether a commit error is CFC enforcement's DETERMINISTIC pre-storage
 * rejection (`rejectCommitBeforeStorage` in extended-storage-transaction.ts):
 * every reason behind it is a verdict on the committed data, so re-running
 * recomputes the identical refused write. The served give-up arm and
 * {@link reportDroppedCfcRejectedWrite} key on this one predicate, so the
 * sealed error consequence and the loss report cover exactly the same class.
 *
 * The class is the test, not the message. A refusal naming something prepare
 * could not evaluate keeps the retryable name and carries the same message
 * prefix, and reporting that one as a dropped write would name a write a later
 * attempt still lands.
 */
export function isCfcRejectedCommitError(
  error: { name?: string; message?: string } | undefined,
): error is { name: "CfcCommitRefusalError"; message: string } {
  return error?.name === "CfcCommitRefusalError" &&
    typeof error.message === "string";
}

/**
 * Report a write that CFC enforcement refused and that nothing will retry.
 *
 * The refusal is a deterministic verdict on the committed data, so the write
 * never lands however many times the code that made it runs again. Both commit
 * paths — the event handler path in events.ts and the reactive action path in
 * run.ts — stop on one, and stopping without a word loses whatever the write
 * carried. Report through `console.error` rather than the scheduler logger,
 * which is opt-in and disabled in deployed workers; the logger call each caller
 * makes alongside carries the rest of the disposition.
 *
 * `writerId` names the code whose write was refused: a handler id on the event
 * path, an action id on the reactive path.
 */
export function reportDroppedCfcRejectedWrite(
  error: { name?: string; message?: string } | undefined,
  writerId: unknown,
): void {
  if (!isCfcRejectedCommitError(error)) return;
  console.error(
    "[cfc] Owner-protected write dropped: CFC enforcement rejected the " +
      "commit and re-running cannot resolve it.",
    { error: error.message, writerId },
  );
}
