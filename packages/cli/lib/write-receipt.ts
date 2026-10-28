/**
 * The receipt a write leaves behind: the space it landed in, named on stderr
 * once a write has actually happened.
 *
 * A wrong space is not an error. The command succeeds, against data nobody
 * meant to touch, and removing a piece from one space is indistinguishable at
 * the prompt from removing it from another. That is the risk an ambient
 * `CF_SPACE` takes on, and naming the space in what the command prints is what
 * answers it — a receipt rather than a prompt, so it costs a non-interactive
 * caller nothing and leaves a wrong space visible the moment it happens
 * (docs/history/plans/cli-surface-shape.md, step 8).
 *
 * Three properties are what make it a receipt:
 *
 * - **It follows the write.** Announcing the target beforehand would name a
 *   space the command may never reach, which is a prompt wearing a receipt's
 *   words.
 * - **`--quiet` does not silence it.** A hint is advice; this is a fact the
 *   operator is owed, and a quiet script is the caller least able to notice a
 *   wrong space on its own.
 * - **It is on stderr.** `get` and `call` reserve stdout for machine-readable
 *   output, so a receipt on stdout would corrupt the thing a caller parses.
 *
 * Reported by the functions that write rather than by a list of commands that
 * do, so a new write path carries it by construction and a command that only
 * writes under `--apply` says nothing on a dry run.
 */

import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "@commonfabric/runner";

/**
 * Spaces already receipted in this process, so a command whose work runs
 * through several write functions reports the space once rather than per call.
 *
 * The memo is the process's rather than one connection's, so a caller that
 * holds a connection across many writes names a space once for the life of
 * the process; `docs/plans/shuttle/runtime-integration.md` carries what that
 * costs such a caller.
 */
const receipted = new Set<string>();

/**
 * Name `space` as written to, unless this process already has. Call it after
 * the write it describes has succeeded.
 */
export function noteWroteTo(space: string): void {
  if (receipted.has(space)) return;
  receipted.add(space);
  console.error(`wrote to space ${space}`);
}

/** Forget what has been receipted. For tests that drive several writes. */
export function resetWriteReceipts(): void {
  receipted.clear();
}

/**
 * Did `tx` write anything to `space`?
 *
 * A resolved `commit()` is not the answer and neither is a `done` status: an
 * empty transaction commits successfully. The journal's novelty for the space
 * is what the transaction actually contributed, so an empty one reports no
 * write and earns no receipt.
 */
export function transactionWroteTo(
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
): boolean {
  const status = tx.status();
  if (status.status === "error") return false;
  for (const _ of status.journal.novelty(space)) return true;
  return false;
}
