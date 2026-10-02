/**
 * Payload-free snapshots of storage work that can hold the durability barrier.
 * Counts describe promise registrations, not distinct writes: a transaction and
 * its scheduler disposition can each register while handling the same write.
 */

import type { MemorySpace } from "@commonfabric/memory/interface";

/** Provenance read only when a pending-work snapshot is requested. */
export type PendingCommitContext = {
  kind:
    | "transaction"
    | "transaction-seal"
    | "action-disposition"
    | "event-disposition"
    | "event-intent"
    | "unknown";
  spaces?: MemorySpace[];
  spacesOmitted?: number;
  transactionStatus?: "ready" | "pending" | "done" | "error";
  commits?: { space: MemorySpace; localSeq?: number; seq?: number }[];
};

/** One registration still holding the manager's durability barrier. */
export type PendingCommitDiagnostic = PendingCommitContext & {
  id: number;
  ageMs: number;
};

/** Existing session state; reading it does not open or retry a session. */
export type SpaceStorageDiagnostic = {
  space: MemorySpace;
  sessionId?: string;
  caughtUpLocalSeq: number;
  pendingCommitCount: number;
  pendingReadCount: number;
  unsettledLocalSeqs: number[];
  unsettledCount: number;
  repairLocalSeqs: number[];
  repairCount: number;
  parkedAcceptLocalSeqs: number[];
  parkedAcceptCount: number;
};

/** Bounded current work, without cell values, credentials, or retained history. */
export type StorageDiagnostics = {
  pendingCommitCount: number;
  pendingCommits: PendingCommitDiagnostic[];
  pendingCommitsOmitted: number;
  pendingCrossSpaceCount: number;
  spaces: SpaceStorageDiagnostic[];
  spacesOmitted: number;
};

/** Maximum entries in each diagnostic list. Counts include omitted entries. */
export const STORAGE_DIAGNOSTICS_LIMIT = 64;

/** Take a bounded prefix without materializing the rest of an iterable. */
export function diagnosticPrefix<T>(values: Iterable<T>): T[] {
  const result: T[] = [];
  for (const value of values) {
    result.push(value);
    if (result.length === STORAGE_DIAGNOSTICS_LIMIT) break;
  }
  return result;
}
