import type { PatternUpdateReceipt } from "@commonfabric/piece/ops";

/**
 * The sentence a committed source update reports when later work fails: the
 * durable outcome first — the revision and the pattern pointer it committed —
 * then the failure that did not undo it.
 */
export function committedSourceWarning(
  receipt: PatternUpdateReceipt,
  failure: string,
): string {
  return `Source revision ${receipt.revisionId} committed as ` +
    `cf:module/${receipt.ref.identity}#${receipt.ref.symbol}, but ${failure}`;
}

/**
 * What `error.log` says when the committed source did not reach the running
 * piece, and `undefined` when that refresh completed or the write made no
 * source update. A clean write clears the log, so dropping this warning would
 * report unqualified success while the piece is still running its previous
 * source.
 */
export function sourceRefreshWarning(
  receipt: PatternUpdateReceipt | undefined,
): string | undefined {
  return receipt?.refresh.status === "failed"
    ? committedSourceWarning(
      receipt,
      `refreshing the running piece failed: ${receipt.refresh.warning}`,
    )
    : undefined;
}

/**
 * Run local FUSE projection work after a source transaction has committed.
 *
 * A failure here cannot undo the receipt and therefore must not reject the
 * filesystem write. A failed result keeps the projection warning separate for
 * the console and composes every post-commit failure for the persistent
 * `error.log` diagnostic.
 */
export async function finalizeCommittedSourceWrite(
  receipt: PatternUpdateReceipt,
  finalize: () => Promise<void>,
) {
  try {
    await finalize();
    return { status: "completed" as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const warning = committedSourceWarning(
      receipt,
      `refreshing the FUSE projection failed: ${message}`,
    );
    const refreshWarning = sourceRefreshWarning(receipt);
    return {
      status: "failed" as const,
      warning,
      logWarning: refreshWarning === undefined
        ? warning
        : `${refreshWarning}\n${warning}`,
      error,
    };
  }
}
