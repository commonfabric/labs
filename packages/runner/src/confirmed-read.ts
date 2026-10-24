import type { Runtime } from "./runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "./storage/interface.ts";
import { markDurableReadTx } from "./storage/reactivity-log.ts";
import { getTransactionReadActivities } from "./storage/transaction-inspection.ts";

/** What {@link readConfirmed} returns. */
export type ConfirmedRead<R> = {
  /** What `read` returned. */
  value: R;

  /**
   * Whether every document `read` consumed holds a known stored version in
   * `space`, with no pending local write or value the replica made up locally.
   * A delivery, an accepted whole-document set or deletion, a write the
   * server elided against the commit's read of the document, or verified
   * content-addressed content in space scope establishes that version
   * (`ISpaceReplica.isConfirmedDocument`). A mutable document without a
   * delivered watch may be stale; confirmation alone does not prove freshness.
   */
  confirmed: boolean;

  /**
   * When `confirmed`, the commit sequence through which the read is complete:
   * every commit at or below it that touched a document `read` consumed is
   * reflected in `value`. Absent whenever the replica cannot say
   * (`ISpaceReplica.completeThroughSeq`): before its first push, after a
   * frame it failed to apply, and while its server runs server execution or
   * does not say whether it does, or when a mutable document has only an
   * accepted-write witness and no delivered watch for subsequent changes.
   */
  seq?: number;
};

/**
 * Runs `read` against the replica of `space` in one transaction that reads past
 * any speculation overlay, and returns what it returned, whether everything it
 * consumed is confirmed, and the sequence the read is complete through.
 *
 * `read` runs synchronously, so every document it consumes is read at one
 * instant: a value assembled from several cells inside it cannot straddle a
 * commit that a value assembled from separate reads can. It reads through the
 * read-only transaction it is given (`cell.withTx(tx).get()`, or `sample()`),
 * where a write throws, and returns plain data; the transaction is closed once
 * it returns or throws, so neither it nor a cell bound to it reads again. Every
 * read counts, whether or not it would schedule anything. Documents not yet
 * loaded read as absent and leave the read unconfirmed, so a caller loads what
 * it reads first, with `sync()` or `pull()`. A document in another space leaves
 * the read unconfirmed.
 */
export function readConfirmed<R>(
  runtime: Runtime,
  space: MemorySpace,
  read: (tx: IExtendedStorageTransaction) => R,
): ConfirmedRead<R> {
  const tx = runtime.readTx();
  try {
    markDurableReadTx(tx);
    const value = read(tx);
    const { replica } = runtime.storageManager.open(space);
    const activities = [...getTransactionReadActivities(tx)];
    const confirmed = replica.isConfirmedDocument !== undefined &&
      activities.every((activity) =>
        activity.space === space &&
        replica.isConfirmedDocument!(activity.id, activity.scope)
      );
    const seq = confirmed
      ? replica.completeThroughSeq?.(activities)
      : undefined;
    return seq === undefined ? { value, confirmed } : { value, confirmed, seq };
  } finally {
    closeReadTx(tx);
  }
}

/** What {@link readDurable} returns. */
export type DurableRead<R> = {
  /** What `read` returned. */
  value: R;

  /**
   * Resolves once every client speculation layer that stood over a document
   * `read` consumed has settled; absent when none stood
   * (`ISpaceReplica.whenSpeculationSettled`).
   */
  speculationSettled?: Promise<void>;
};

/**
 * Runs `read` against this runtime's replicas in one transaction that reads
 * past any speculation overlay, and returns what it returned, with a promise
 * for when the speculation layers over the documents it consumed have settled.
 * What it reads is the durable view: confirmed state with this runtime's own
 * pending writes over it, in any space. `read` runs as it does in
 * {@link readConfirmed}.
 *
 * A reader subscribed to a cell learns of changes to what the cell shows,
 * which a speculation layer masks. A change to the durable view beneath a
 * layer shows nothing, and neither does the layer's retirement over a durable
 * value equal to its own. So a reader waiting for the durable view to say
 * something reads again on each change its subscription delivers and once
 * `speculationSettled` resolves.
 */
export function readDurable<R>(
  runtime: Runtime,
  read: (tx: IExtendedStorageTransaction) => R,
): DurableRead<R> {
  const tx = runtime.readTx();
  try {
    markDurableReadTx(tx);
    const value = read(tx);
    const standing: Promise<void>[] = [];
    const visited = new Set<string>();
    for (const activity of getTransactionReadActivities(tx)) {
      const key = `${activity.space}\0${activity.id}\0${activity.scope}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const { replica } = runtime.storageManager.open(activity.space);
      const settled = replica.whenSpeculationSettled?.(
        activity.id,
        activity.scope,
      );
      if (settled !== undefined) standing.push(settled);
    }
    return standing.length === 0
      ? { value }
      : { value, speculationSettled: Promise.all(standing).then(() => {}) };
  } finally {
    closeReadTx(tx);
  }
}

/**
 * Helper for {@link readConfirmed} and {@link readDurable}, which closes the
 * read-only transaction a read ran in.
 */
function closeReadTx(tx: IExtendedStorageTransaction): void {
  // A read-only transaction refuses abort(); closing it releases the reads
  // it cached, which a callback that kept it would otherwise hold.
  tx.clearReadOnly?.();
  tx.abort();
}
