/** Observes a coordination marker's fate before waiting for its coverage. */

import type { TransactionCommitReceipt } from "@commonfabric/runner";

/** Reports a failed announcement promptly and waits for accepted coverage. */
export async function waitForMarkerCommit(
  marker: string,
  receipt: TransactionCommitReceipt,
): Promise<void> {
  // A rejected marker will never arrive for another participant to observe.
  const verdict = await receipt.verdict;
  if (verdict.error) {
    throw new Error(
      `Announcing marker "${marker}" failed: ${verdict.error.message}`,
    );
  }
  const settled = await receipt.settled;
  if (settled.error) {
    throw new Error(
      `Announcing marker "${marker}" failed: ${settled.error.message}`,
    );
  }
}
