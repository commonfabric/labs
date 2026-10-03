/** Tracks commit readiness scope and settlement for runtime-owned observers. */
import type {
  CommitError,
  IStorageTransaction,
  Result,
  Unit,
} from "./interface.ts";

const documentLocal = new WeakMap<object, boolean>();
const settlements = new WeakMap<object, Promise<Result<Unit, CommitError>>>();

/** Certifies ordinary storage work unless a broader effect has been registered. */
export function declareDocumentLocalCommit(tx: IStorageTransaction): void {
  if (documentLocal.get(tx) !== false) documentLocal.set(tx, true);
}

/** Retains the runtime-wide barrier for callbacks and producer lifecycle work. */
export function declareGlobalCommit(tx: IStorageTransaction): void {
  const visited = new WeakSet<object>();
  let current: object = tx;
  while (!visited.has(current)) {
    visited.add(current);
    documentLocal.set(current, false);
    const nested = "tx" in current ? current.tx : undefined;
    if (nested === null || typeof nested !== "object") break;
    current = nested;
  }
}

/** Whether this transaction has a document-local readiness certification. */
export function isDocumentLocalCommit(tx: IStorageTransaction): boolean {
  return documentLocal.get(tx) === true;
}

/** Retains the first storage or seal attempt for runtime-owned late observers. */
export function rememberCommitSettlement(
  tx: object,
  settled: Promise<Result<Unit, CommitError>>,
): void {
  if (!settlements.has(tx)) settlements.set(tx, settled);
}

/** Observes the started attempt without registering a new commit hook. */
export function commitSettlementOf(
  tx: object,
): Promise<Result<Unit, CommitError>> | undefined {
  const visited = new WeakSet<object>();
  let current = tx;
  while (!visited.has(current)) {
    visited.add(current);
    const settled = settlements.get(current);
    if (settled !== undefined) return settled;
    const nested = "wrappedTransaction" in current
      ? current.wrappedTransaction
      : "tx" in current
      ? current.tx
      : undefined;
    if (nested === null || typeof nested !== "object") return undefined;
    current = nested;
  }
  return undefined;
}
