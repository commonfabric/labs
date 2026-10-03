/** Builds the observable stages of a transaction commit attempt. */
import type { TransactionCommitReceipt } from "./interface.ts";

type Receipt<T> = Omit<TransactionCommitReceipt, "verdict" | "settled"> & {
  readonly verdict: Promise<T>;
  readonly settled: Promise<T>;
};

const failureReporters = new WeakMap<
  Receipt<unknown>,
  (error: unknown) => void
>();

/** Pairs settlement with an optional earlier verdict and reports internal failures. */
export function createTransactionCommitReceipt<T>(
  settled: Promise<T>,
  signal?: Promise<T>,
  source?: Receipt<unknown>,
): Receipt<T> {
  const verdict = signal === undefined
    ? settled
    : Promise.race([signal, settled]);
  let reported = false;
  const report =
    (source === undefined ? undefined : failureReporters.get(source)) ??
      ((error: unknown) => {
        if (reported) return;
        reported = true;
        console.error("[storage] transaction commit failed internally:", error);
      });
  // Settlement can reject after an accepted verdict. Observe both promises
  // so either failure is reported, while callers still receive the rejection.
  void settled.catch(report);
  if (verdict !== settled) void verdict.catch(report);
  const receipt = Object.freeze({ verdict, settled });
  failureReporters.set(receipt, report);
  return receipt;
}
