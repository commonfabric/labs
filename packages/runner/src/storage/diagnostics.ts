/**
 * Payload-free snapshots of storage work that can hold the durability barrier.
 * Counts describe promise registrations, not distinct writes: a transaction and
 * its scheduler disposition can each register while handling the same write.
 */

import type { MemorySpace } from "@commonfabric/memory/interface";
import type { SpaceDocumentSizes } from "./document-sizes.ts";

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

  /**
   * This space's share of the manager's sizes, which add every open space
   * together. Its commit and read counts are the ones above, under the names
   * the sizes give them.
   */
  sizes: SpaceStorageSizes;
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

/** Sizes of one space replica's live structures, each a collection's own count. */
export type SpaceStorageSizes = {
  /** Documents the replica holds. */
  documents: number;

  /** Documents with at least one sink. */
  subscribedDocuments: number;

  /** Sinks across every document. */
  subscriptions: number;

  /** Documents watched on the session. */
  watchedDocuments: number;

  /** Operation fields with at least one sink. */
  operationSinks: number;

  /** Commits issued and not yet settled. */
  inFlightCommits: number;

  /** Commits whose outcome is still pending, by sequence. */
  unsettledCommits: number;

  /** Rejected commits whose optimistic layer is still being dropped. */
  repairingCommits: number;

  /** Accepted commits held back from application. */
  parkedAccepts: number;

  /** Sync tasks in flight. */
  syncTasks: number;

  /** Reads in flight. */
  pendingReads: number;
};

/** Sizes across every open space, plus the manager's own. */
export type StorageSizes = SpaceStorageSizes & {
  /** Spaces open. */
  spaces: number;

  /** Commits registered with the durability barrier. */
  pendingCommits: number;

  /** Document loads in flight. */
  pendingLoads: number;

  /** Crossing loads in flight. */
  pendingCrossingLoads: number;

  /** Cross-space promises in flight. */
  pendingCrossSpace: number;

  /**
   * Each open space's documents and their approximate size, largest first,
   * at most {@link STORAGE_DIAGNOSTICS_LIMIT} of them; `bySpaceOmitted` adds
   * the rest together. The entries' `documents` and `watched` add up to the
   * manager's `documents` and `watchedDocuments`.
   */
  bySpace: SpaceDocumentSizes[];

  /** The spaces past the cap on `bySpace`, added together. */
  bySpaceOmitted: Omit<SpaceDocumentSizes, "space"> & { spaces: number };

  /** Documents measured whole across every space; see `SpaceDocumentSizes`. */
  measuredDocuments: number;

  /** Documents held as a lower bound across every space. */
  truncatedDocuments: number;

  /** The approximate size of every space's documents, added together. */
  approxBytes: number;

  /**
   * What the memory connections have carried, or `null` for a session
   * factory that reports none.
   */
  wire: MemoryConnectionSizes | null;
};

/**
 * What the connections to memory servers have carried since the session
 * factory was created, closed ones included, and what the open ones hold
 * queued. A transport is one logical connection, which keeps its place and
 * its counts across the sockets it dials; the bytes are the frames' sizes
 * on the wire, a text frame's UTF-8 size among them.
 */
export type MemoryConnectionSizes = {
  /** Transports the factory holds, a reconnecting one included. */
  transports: number;

  /** Transports closed since the factory was created. */
  transportsClosed: number;

  /** Transports whose socket is open right now. */
  socketsOpen: number;

  /** Frames handed to a socket. */
  messagesSent: number;

  /** The size of every frame handed to a socket. */
  bytesSent: number;

  /** Frames a socket delivered. */
  messagesReceived: number;

  /** The size of every frame a socket delivered. */
  bytesReceived: number;

  /**
   * Bytes the open sockets hold queued for the network, as each socket's own
   * `bufferedAmount` reports; a peer that reads slowly shows up here.
   */
  bufferedAmount: number;
};

/** Adds every replica's sizes together, field by field. */
export function sumSpaceStorageSizes(
  sizes: Iterable<SpaceStorageSizes>,
): SpaceStorageSizes {
  const total: SpaceStorageSizes = {
    documents: 0,
    subscribedDocuments: 0,
    subscriptions: 0,
    watchedDocuments: 0,
    operationSinks: 0,
    inFlightCommits: 0,
    unsettledCommits: 0,
    repairingCommits: 0,
    parkedAccepts: 0,
    syncTasks: 0,
    pendingReads: 0,
  };
  for (const size of sizes) {
    for (const key of Object.keys(total) as (keyof SpaceStorageSizes)[]) {
      total[key] += size[key];
    }
  }
  return total;
}

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
