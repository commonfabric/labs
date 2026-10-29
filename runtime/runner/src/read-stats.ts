/**
 * Accounts for reactive reads within one scheduler action's transaction.
 * The disabled path skips lookup and allocation at every read site.
 */

import type { IExtendedStorageTransaction } from "./storage/interface.ts";
import type { ActionReadStats } from "./telemetry.ts";

/** Mutable counters for a transaction whose action is being measured. */
interface ReadCounter {
  /** Property and element reads, including array materialization. */
  proxyAccesses: number;

  /** Stored-link traversal attempts, excluding memo hits. */
  linkResolutions: number;

  /** Replica document records touched by storage reads. */
  documents: Set<object>;
}

/** Local read work retained through a transaction's settlement. */
export type ReadAttemptCounts = Pick<
  ActionReadStats,
  "proxyAccesses" | "linkResolutions"
>;

const counters = new WeakMap<object, ReadCounter>();
let activeCount = 0;

/** Whether any action is collecting reads in this process. */
export let readStatsActive = false;

/**
 * Starts accounting for `tx` and returns a body checkpoint function.
 * With a completion observer, counters remain active through commit or abort;
 * otherwise the body checkpoint stops collection.
 * Transactions belonging to other actions remain independent across awaits.
 */
export function startReadStats(
  tx: IExtendedStorageTransaction,
  onComplete?: (counts: ReadAttemptCounts) => void,
): (registeredDependencies: number) => ActionReadStats {
  if (counters.has(tx.tx)) {
    throw new Error("Read accounting is already active for this transaction");
  }
  const counter: ReadCounter = {
    proxyAccesses: 0,
    linkResolutions: 0,
    documents: new Set(),
  };
  let finished = false;
  const stop = () => {
    if (!finished) {
      counters.delete(tx.tx);
      readStatsActive = --activeCount > 0;
      finished = true;
    }
  };
  if (onComplete !== undefined) {
    tx.addCommitCallback(() => {
      stop();
      onComplete({
        proxyAccesses: counter.proxyAccesses,
        linkResolutions: counter.linkResolutions,
      });
    });
  }
  counters.set(tx.tx, counter);
  activeCount++;
  readStatsActive = true;
  return (registeredDependencies) => {
    if (onComplete === undefined) stop();
    return {
      proxyAccesses: counter.proxyAccesses,
      linkResolutions: counter.linkResolutions,
      distinctDocuments: counter.documents.size,
      registeredDependencies,
    };
  };
}

/** Records a property or element read, including a cached view read. */
export function recordProxyAccess(tx: IExtendedStorageTransaction): void {
  const counter = counters.get(tx.tx);
  if (counter) counter.proxyAccesses++;
}

/** Records a stored-link traversal attempt, excluding memo hits. */
export function recordLinkResolution(tx: IExtendedStorageTransaction): void {
  const counter = counters.get(tx.tx);
  if (counter) counter.linkResolutions++;
}

/** Records the replica document selected by a storage read. */
export function recordDocumentRead(tx: object, document: object): void {
  counters.get(tx)?.documents.add(document);
}
