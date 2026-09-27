import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
  IReadActivity,
  IStorageTransaction,
  IWriteAttempt,
  MemorySpace,
  NativeStorageCommit,
  TransactionReactivityLog,
  TransactionReadDetail,
  TransactionWriteDetail,
} from "./interface.ts";

import { pendingWriteElisionRead } from "./reactivity-log.ts";

type TxLike = IStorageTransaction | IExtendedStorageTransaction;

const unwrap = (tx: TxLike): IStorageTransaction => {
  return "tx" in tx ? tx.tx : tx;
};

export function getDirectTransactionMergeableOpAddresses(
  tx: TxLike,
): Iterable<IMemorySpaceAddress> | undefined {
  return tx.getMergeableOpAddresses?.() ??
    unwrap(tx).getMergeableOpAddresses?.();
}

/**
 * Build the native commit for `space` without committing. Inspection-only: the
 * build is what resolves recorded mergeable intents into wire ops, so this is
 * how a caller observes decisions the commit makes before it is sent.
 */
export function getDirectTransactionNativeCommit(
  tx: TxLike,
  space: MemorySpace,
): NativeStorageCommit | undefined {
  return tx.getNativeCommit?.(space) ?? unwrap(tx).getNativeCommit?.(space);
}

export function getDirectTransactionReactivityLog(
  tx: TxLike,
): TransactionReactivityLog | undefined {
  return tx.getReactivityLog?.() ?? unwrap(tx).getReactivityLog?.();
}

export function getDirectTransactionReadActivities(
  tx: TxLike,
): Iterable<IReadActivity> | undefined {
  return tx.getReadActivities?.() ?? unwrap(tx).getReadActivities?.();
}

export function getTransactionReadActivities(
  tx: TxLike,
): Iterable<IReadActivity> {
  const direct = getDirectTransactionReadActivities(tx);
  if (direct) {
    return direct;
  }
  // Journal fallback: the activity stream is the temporal read|write
  // interleaving, so the stream position doubles as the activity-clock
  // stamp V2 transactions record natively (see IReadActivity.journalIndex).
  // getTransactionWriteAttempts derives write indices from the same
  // enumeration, keeping both on one clock.
  return (function* () {
    let journalIndex = 0;
    for (const activity of tx.journal.activity()) {
      if ("read" in activity && activity.read) {
        yield { ...activity.read, journalIndex };
      }
      journalIndex += 1;
    }
  })();
}

/** Reports a write that reused an unaccepted output instead of replacing it. */
export function hasPendingWriteElision(tx: TxLike): boolean {
  for (const { meta } of getTransactionReadActivities(tx)) {
    if (meta === pendingWriteElisionRead) return true;
  }
  return false;
}

/**
 * Ordered log of the transaction's applied write attempts, on the same
 * per-transaction activity clock as `getTransactionReadActivities`. Prefers
 * the transaction's native log (V2); falls back to deriving positional
 * indices from the journal activity stream. Returns undefined when neither
 * source exists — callers must treat that as "order unknown" and fail toward
 * transaction-global gating (docs/specs/cfc-write-prefix-provenance.md §4).
 */
export function getTransactionWriteAttempts(
  tx: TxLike,
): readonly IWriteAttempt[] | undefined {
  const direct = tx.getWriteAttemptLog?.() ??
    unwrap(tx).getWriteAttemptLog?.();
  if (direct) {
    return direct;
  }
  try {
    const attempts: IWriteAttempt[] = [];
    let journalIndex = 0;
    for (const activity of tx.journal.activity()) {
      if ("write" in activity && activity.write) {
        attempts.push({ ...activity.write, journalIndex });
      }
      journalIndex += 1;
    }
    return attempts;
  } catch {
    // V2 journals throw on activity(); a V2 transaction always provides the
    // native log above, so reaching here means a custom transaction with
    // neither source.
    return undefined;
  }
}

export function getTransactionReadDetails(
  tx: TxLike,
  space: MemorySpace,
): Iterable<TransactionReadDetail> {
  const direct = tx.getReadDetails?.(space) ??
    unwrap(tx).getReadDetails?.(space);
  if (direct) {
    return direct;
  }

  // Fallback for a transaction that records read invariants only as journal
  // history.
  return (function* () {
    for (const attestation of tx.journal.history(space)) {
      yield {
        address: { ...attestation.address, space },
        value: attestation.value as TransactionReadDetail["value"],
      };
    }
  })();
}

export function getTransactionWriteDetails(
  tx: TxLike,
  space: MemorySpace,
): Iterable<TransactionWriteDetail> {
  const direct = tx.getWriteDetails?.(space) ??
    unwrap(tx).getWriteDetails?.(space);
  if (direct) {
    return direct;
  }

  return (function* () {
    const previousValues = new Map<
      string,
      TransactionWriteDetail["previousValue"]
    >();
    for (const attestation of tx.journal.history(space)) {
      previousValues.set(
        `${attestation.address.id}:${attestation.address.path.join(".")}`,
        attestation.value as TransactionWriteDetail["previousValue"],
      );
    }

    for (const attestation of tx.journal.novelty(space)) {
      const key = `${attestation.address.id}:${
        attestation.address.path.join(".")
      }`;
      const detail: TransactionWriteDetail = {
        address: {
          ...attestation.address,
          space,
        },
        value: attestation.value as TransactionWriteDetail["value"],
        previousValue: previousValues.get(key),
      };
      yield detail;
    }
  })();
}

/**
 * The spaces `tx` recorded a write in (`IStorageTransaction.getWrittenSpaces`).
 * A transaction without the native list reports the spaces its journal's write
 * activities name. One whose journal cannot replay its activity either
 * reports the spaces its direct reactivity log names in `writes` or
 * `attemptedWrites`. The log's `writes` list only changed paths, so that
 * leaves out a space whose every write returned to where it started unless
 * one of those writes also recorded an attempted write, as a write through
 * the value diff does. A transaction offering none of the three throws the
 * journal's error. A V2 transaction always provides the list.
 */
export function getTransactionWrittenSpaces(
  tx: TxLike,
): readonly MemorySpace[] {
  const direct = tx.getWrittenSpaces?.() ?? unwrap(tx).getWrittenSpaces?.();
  if (direct) {
    return direct;
  }

  const spaces = new Set<MemorySpace>();
  try {
    for (const activity of tx.journal.activity()) {
      if ("write" in activity && activity.write) {
        spaces.add(activity.write.space);
      }
    }
  } catch (error) {
    const log = getDirectTransactionReactivityLog(tx);
    if (log === undefined) {
      throw error;
    }
    return [
      ...new Set(
        [...log.writes, ...(log.attemptedWrites ?? [])].map((write) =>
          write.space
        ),
      ),
    ];
  }
  return [...spaces];
}
