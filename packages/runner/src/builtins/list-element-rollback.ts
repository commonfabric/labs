import type { Cell } from "../cell.ts";
import { waveSettlementOf } from "../executor/wave.ts";
import type { Runtime } from "../runtime.ts";
import {
  isConflictRejection,
  isStorageTransactionInconsistent,
} from "../storage/rejection.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";

/**
 * The record of one set of setup writes a list coordinator has issued.
 *
 * `needsSetup` says those writes are not known to be durable, so the next
 * reconcile issues them again. Issuing them clears it, and the rollback below
 * sets it again when the reconcile carrying them does not become durable. A
 * coordinator keeps one of these per element, and one for the result container
 * it hands to its output binding.
 */
export type SetupRecord = {
  needsSetup: boolean;

  /** The reconcile that last issued these setup writes. */
  setupIssuance?: object;
};

/**
 * The per-element bookkeeping a list coordinator keeps across reconciles.
 */
export type ElementRun = SetupRecord & {
  resultCell: Cell<any>;
  lastIndex: number;
};

export interface ListSetupRollback {
  /** An entry this reconcile added to the coordinator's element map. */
  created(elementKey: string, entry: ElementRun): void;

  /** Setup writes this reconcile staged against a record it already had. */
  setupIssued(record: SetupRecord): void;

  /** An index this reconcile moved, with the value it moved away from. */
  indexChanged(entry: ElementRun, previousIndex: number): void;

  /** A result container this reconcile installed, with a restore for the old one. */
  resultReplaced(restore: () => void): void;
}

/**
 * Undo a reconcile's in-memory bookkeeping when its transaction does not become
 * durable.
 *
 * A reconcile records an element's result cell and index in plain memory while
 * writing that element's setup through its transaction. The memory survives a
 * transaction that is rejected or aborted, so the next reconcile finds the entry,
 * reuses it, and never re-runs the setup whose writes are gone. The element then
 * has no pattern and reads as undefined for as long as the coordinator lives.
 *
 * A stale basis is the exception. A conflict or a local inconsistency re-runs
 * the same reconcile against fresh state, and that re-run is what converges;
 * it reuses this bookkeeping and re-issues only the writes it still needs.
 * Tearing the bookkeeping down under it makes each attempt rebuild the elements
 * it just discarded, and the reconcile stops converging altogether. Every other
 * outcome — an abort, a terminal or permanent refusal, a transport failure —
 * has no such re-run behind it, so the record has to go.
 *
 * The setup writes themselves are what the re-run has to re-issue, and every
 * failed outcome loses them, stale basis included. Marking the record as
 * needing setup again is therefore the one undo that applies to all of them: an
 * element whose entry survives is set up again by the next reconcile, rather
 * than reading as undefined for as long as the coordinator lives. The result
 * container's own links are setup writes of the same kind — the coordinator
 * keeps the container in memory, so a reconcile that loses those links leaves
 * a container nothing points at — and they are marked and re-issued the same
 * way.
 *
 * On a serving runtime a transaction commits when it is sealed into a wave, and
 * the wave can still withdraw it afterwards — when it read a pending write the
 * wave drops, say. A withdrawal loses the setup writes too, so it marks them as
 * owed, and that is all it undoes: the entries stay, and whichever reconcile
 * runs next sets them up again, as it does after a stale basis.
 *
 * Each undo checks that the state it is about to revert is still the state this
 * reconcile installed. An overlapping reconcile that has already moved the same
 * entry owns it, and its bookkeeping matches durable writes of its own.
 */
export function trackListSetupRollback(
  tx: IExtendedStorageTransaction,
  runtime: Runtime,
  elementRuns: Map<string, ElementRun>,
): ListSetupRollback {
  const created = new Map<string, ElementRun>();
  const setUp = new Set<SetupRecord>();
  const indexChanges = new Map<
    ElementRun,
    { from: number; to: number }
  >();
  const resultRestores: Array<() => void> = [];
  let registered = false;

  // This tracker's identity as an issuer of setup writes. Two reconciles for
  // one coordinator overlap whenever the first is still awaiting its commit,
  // and the debt belongs to whichever of them issued the setup last: a
  // transaction that failed after a later one made the same element durable
  // has nothing to restore.
  const issuance = {};

  const markSetupIssued = (record: SetupRecord): void => {
    record.setupIssuance = issuance;
    setUp.add(record);
    record.needsSetup = false;
  };

  const markSetupOwed = (): void => {
    for (const record of setUp) {
      if (record.setupIssuance !== issuance) continue;
      record.needsSetup = true;
    }
  };

  const registerRollback = (): void => {
    if (registered) return;
    registered = true;
    tx.addCommitCallback((committed, result) => {
      if (!result.error) {
        const settlement = waveSettlementOf(committed) ?? waveSettlementOf(tx);
        void settlement?.then(({ error }) => {
          if (error) markSetupOwed();
        });
        return;
      }
      markSetupOwed();
      if (
        isConflictRejection(result.error) ||
        isStorageTransactionInconsistent(result.error)
      ) {
        return;
      }
      const errors: unknown[] = [];
      for (const [elementKey, entry] of created) {
        if (elementRuns.get(elementKey) !== entry) continue;
        elementRuns.delete(elementKey);
        indexChanges.delete(entry);
        try {
          runtime.runner.stop(entry.resultCell);
        } catch (error) {
          errors.push(error);
        }
      }
      for (const [entry, { from, to }] of indexChanges) {
        if (entry.lastIndex === to) entry.lastIndex = from;
      }
      for (const restore of resultRestores) {
        try {
          restore();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "Multiple list element rollbacks failed",
        );
      }
    });
  };

  return {
    created(elementKey, entry) {
      created.set(elementKey, entry);
      markSetupIssued(entry);
      registerRollback();
    },
    setupIssued(record) {
      markSetupIssued(record);
      registerRollback();
    },
    indexChanged(entry, previousIndex) {
      const existing = indexChanges.get(entry);
      if (existing) {
        existing.to = entry.lastIndex;
      } else {
        indexChanges.set(entry, { from: previousIndex, to: entry.lastIndex });
      }
      registerRollback();
    },
    resultReplaced(restore) {
      resultRestores.push(restore);
      registerRollback();
    },
  };
}
