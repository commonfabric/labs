/** Enumerates occupied index keys when a consumer demands that surface. */

import type { AddCancel } from "../cancel.ts";
import { type Cell, cellRuntime } from "../cell.ts";
import type { RawBuiltinReturnType } from "../module.ts";
import { snapshotQueryResult } from "../query-result-proxy.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { compareCollectionKeys } from "./collection-index-key.ts";
import type { CollectionIndexMembership } from "./collection-index-membership.ts";

/**
 * Reads raw occupied keys in deterministic typed order, preserving Cell keys.
 * Tagged entries keep primitive values and Cell identities in distinct fields.
 */
export function readCollectionIndexKeys(
  tx: IExtendedStorageTransaction,
  state: Cell<CollectionIndexMembership>,
  tagged = false,
): unknown[] {
  const occupied = Object.values(
    snapshotQueryResult(state.withTx(tx).key("occupied").get() ?? {}),
  ).filter((entry) => entry !== undefined)
    .sort((a, b) => compareCollectionKeys(a.identity, b.identity));
  return occupied.map((entry) => {
    if (entry.cell) {
      const cell = cellRuntime(state).getCellFromLink(
        entry.cell,
        undefined,
        tx,
      );
      return tagged ? { kind: "cell", cell } : cell;
    }
    return tagged
      ? { kind: "value", value: entry.identity.value }
      : entry.identity.value;
  });
}

/** Publishes enumeration through an ordinary demanded child result. */
export function collectionIndexKeys(
  inputs: Cell<{ state: CollectionIndexMembership; tagged?: boolean }>,
  sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
  _addCancel: AddCancel,
): RawBuiltinReturnType {
  return {
    deferUntilDemand: true,
    action: (tx) => {
      sendResult(
        tx,
        readCollectionIndexKeys(
          tx,
          inputs.withTx(tx).key("state").resolveAsCell(),
          inputs.withTx(tx).key("tagged").get() === true,
        ),
      );
    },
  };
}
