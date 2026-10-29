/** Maintains one occurrence's index membership in the caller's transaction. */

import { hashStringOf } from "@commonfabric/data-model";
import { utf8Compare } from "@commonfabric/utils/utf8";

import {
  type Cell,
  cellRuntime,
  recordRelevantSchemaWritePolicyInput,
} from "../cell.ts";
import type { NormalizedFullLink } from "../link-types.ts";
import { snapshotQueryResult } from "../query-result-proxy.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  allowMutableTransactionRead,
  ignoreReadForScheduling,
  machineryRead,
  markReadAsAttemptedWrite,
} from "../storage/reactivity-log.ts";
import {
  collectionKeyBucket,
  type CollectionKeyIdentity,
  type ResolvedCollectionKey,
} from "./collection-index-key.ts";

/** Original source occurrence retained as address data. */
interface IndexMember {
  /** Existing collection occurrence identity used for deterministic ordering. */
  occurrence: string;

  /** Original source address, including its scope. */
  element: NormalizedFullLink;
}

/** Occupied key with enough address data to publish its public representation. */
interface OccupiedKey {
  /** Typed routing identity. */
  identity: CollectionKeyIdentity;

  /** Resolved address for Cell keys. */
  cell?: NormalizedFullLink;
}

/** Current bucket and source occurrence needed to reconcile durable removals. */
interface IndexAssignment {
  /** Internal typed-key bucket address. */
  bucket: string;

  /** Original collection occurrence identity. */
  occurrence: string;
}

/** Durable maintenance records belonging to one scoped index instance. */
export interface CollectionIndexMembership {
  /** Current bucket of each occurrence, addressed by canonical occurrence hash. */
  assignments: Record<string, IndexAssignment | undefined>;

  /** Members of each bucket, independently addressed from other buckets. */
  members: Record<string, Record<string, IndexMember> | undefined>;

  /** Occupied key metadata used by demanded enumeration. */
  occupied: Record<string, OccupiedKey | undefined>;

  /** Winning occurrence hashes for unique-key buckets; populated on demand. */
  winners?: Record<string, string | undefined>;

  /** Sorted occurrence identities aligned with each published group. */
  orders?: Record<string, string[] | undefined>;
}

/** Public index descriptor whose groups preserve original source links. */
export interface MaintainedCollectionIndex {
  /** Descriptor recognized by Cell lookup. */
  kind: "collection-index";

  /** Empty-result and duplicate-selection behavior. */
  mode: "group" | "key";

  /** Occupied keys in deterministic typed order. */
  keys: unknown[];

  /** Occupied keys with explicit value and Cell tags. */
  keyEntries?: unknown[];

  /** Independently published bucket values. */
  buckets: Record<string, unknown>;
}

/** Deletes one owned slot without following its stored source reference. */
function deleteIndexSlot(
  tx: IExtendedStorageTransaction,
  cell: Cell<unknown>,
): void {
  const link = cell.getAsNormalizedFullLink();
  tx.readValueOrThrow(link, {
    meta: { ...markReadAsAttemptedWrite, ...allowMutableTransactionRead },
  });
  recordRelevantSchemaWritePolicyInput(tx, link, link.schema ?? cell.schema);
  tx.writeValueOrThrow(link, undefined, { delete: true });
  tx.poisonMergeableOp?.(link);
}

/** Finds the first occurrence when a unique bucket needs a replacement winner. */
function firstMember(members: Record<string, IndexMember>): string | undefined {
  let winner: string | undefined;
  for (const id of Object.keys(members)) {
    if (
      winner === undefined ||
      utf8Compare(members[id].occurrence, members[winner].occurrence) < 0
    ) winner = id;
  }
  return winner;
}

/** Updates one unique-key member without rebuilding an unchanged winning value. */
function updateUniqueBucket(
  tx: IExtendedStorageTransaction,
  stored: Cell<CollectionIndexMembership>,
  output: Cell<MaintainedCollectionIndex>,
  bucket: string,
  memberId: string,
  member: IndexMember | undefined,
  wasOccupied: boolean,
): boolean {
  const members = stored.key("members").key(bucket);
  const winners = stored.key("winners");
  if (winners.get() === undefined) winners.set({});
  const winnerSlot = winners.key(bucket);
  const winnerCell = winnerSlot.asSchema<string | undefined>(winnerSlot.schema);
  function readMember(id: string) {
    const slot = members.key(id);
    return slot.asSchema<IndexMember | undefined>(slot.schema).get();
  }
  let winnerId = winnerCell.get();
  // Durable membership can exist before its optional winner cache is populated.
  if (winnerId === undefined && wasOccupied) {
    winnerId = firstMember(snapshotQueryResult(members.get() ?? {}));
  }
  const previousWinner = winnerId;
  if (member) {
    members.key(memberId).set(member);
    if (
      winnerId === undefined || winnerId === memberId ||
      utf8Compare(member.occurrence, readMember(winnerId)!.occurrence) < 0
    ) winnerId = memberId;
  } else {
    deleteIndexSlot(tx, members.key(memberId));
    if (winnerId === memberId) {
      winnerId = firstMember(snapshotQueryResult(members.get() ?? {}));
    }
  }
  if (winnerId === undefined) {
    deleteIndexSlot(tx, winnerCell);
    deleteIndexSlot(tx, members);
    deleteIndexSlot(tx, output.key("buckets").key(bucket));
    return false;
  }
  if (winnerCell.get() !== winnerId) winnerCell.set(winnerId);
  if (
    winnerId !== previousWinner || (member && winnerId === memberId) ||
    output.key("buckets").key(bucket).getRaw() === undefined
  ) {
    const selected = member && winnerId === memberId
      ? member
      : snapshotQueryResult(readMember(winnerId)!);
    output.key("buckets").key(bucket).set(
      cellRuntime(output).getCellFromLink(selected.element, undefined, tx),
    );
  }
  return true;
}

/** Updates one ordered group while retaining its unchanged source links. */
function updateGroupBucket(
  tx: IExtendedStorageTransaction,
  stored: Cell<CollectionIndexMembership>,
  output: Cell<MaintainedCollectionIndex>,
  bucket: string,
  memberId: string,
  occurrence: string,
  member: IndexMember | undefined,
): boolean {
  const members = stored.key("members").key(bucket);
  const orders = stored.key("orders");
  if (orders.get() === undefined) orders.set({});
  const orderSlot = orders.key(bucket);
  const published = output.key("buckets").key(bucket);
  const previousOrder = orderSlot.getRaw();
  const previousGroup = published.getRaw();
  if (member) members.key(memberId).set(member);
  else deleteIndexSlot(tx, members.key(memberId));

  let order: string[];
  let group: unknown[];
  if (
    previousOrder !== undefined && Array.isArray(previousGroup) &&
    previousOrder.length === previousGroup.length
  ) {
    order = previousOrder.slice();
    group = previousGroup.slice();
    let low = 0;
    let high = order.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (utf8Compare(order[middle], occurrence) < 0) low = middle + 1;
      else high = middle;
    }
    const present = order[low] === occurrence;
    if (member) {
      order.splice(low, present ? 1 : 0, occurrence);
      group.splice(
        low,
        present ? 1 : 0,
        cellRuntime(output).getCellFromLink(member.element, undefined, tx),
      );
    } else if (present) {
      order.splice(low, 1);
      group.splice(low, 1);
    }
  } else {
    // Reconstruct the optional order cache from durable membership.
    const sorted = Object.values(snapshotQueryResult(members.get() ?? {}))
      .sort((a, b) => utf8Compare(a.occurrence, b.occurrence));
    order = sorted.map((entry) => entry.occurrence);
    group = sorted.map((entry) =>
      cellRuntime(output).getCellFromLink(entry.element, undefined, tx)
    );
  }
  if (order.length === 0) {
    deleteIndexSlot(tx, orderSlot);
    deleteIndexSlot(tx, members);
    deleteIndexSlot(tx, published);
    return false;
  }
  orderSlot.set(order);
  published.set(group);
  return true;
}

/**
 * Moves or removes one source occurrence and publishes its affected buckets.
 * The owning coordinator supplies runtime-owned cells in the index's scope.
 * Maintenance reads participate in transaction conflict checks but do not make
 * other members' writes reactive inputs of this occurrence's key extractor.
 */
export function maintainCollectionIndexMembership(
  tx: IExtendedStorageTransaction,
  state: Cell<CollectionIndexMembership>,
  index: Cell<MaintainedCollectionIndex>,
  mode: "group" | "key",
  occurrence: string,
  key: ResolvedCollectionKey | undefined,
  element: Cell<unknown>,
): void {
  const stored = state.withTx(tx);
  const output = index.withTx(tx);
  const memberId = hashStringOf(occurrence);
  const next = key ? collectionKeyBucket(key.identity) : undefined;
  tx.runWithAmbientReadMeta(
    { ...ignoreReadForScheduling, ...machineryRead },
    () => {
      const previous = stored.key("assignments").key(memberId).get()?.bucket;
      const affected = new Set([previous, next]);
      for (const bucket of affected) {
        if (bucket === undefined) continue;
        const member = bucket === next
          ? {
            occurrence,
            element: element.getAsNormalizedFullLink(),
          }
          : undefined;
        let wasOccupied: boolean;
        let isOccupied: boolean;
        if (mode === "key") {
          wasOccupied = stored.key("occupied").key(bucket).get() !== undefined;
          isOccupied = updateUniqueBucket(
            tx,
            stored,
            output,
            bucket,
            memberId,
            member,
            wasOccupied,
          );
        } else {
          wasOccupied = stored.key("occupied").key(bucket).get() !== undefined;
          isOccupied = updateGroupBucket(
            tx,
            stored,
            output,
            bucket,
            memberId,
            occurrence,
            member,
          );
        }
        if (wasOccupied !== isOccupied) {
          if (isOccupied) {
            stored.key("occupied").key(bucket).set({
              identity: key!.identity,
              ...(key!.identity.kind === "cell"
                ? {
                  cell: (key!.key as Cell<unknown>).getAsNormalizedFullLink(),
                }
                : {}),
            });
          } else {
            deleteIndexSlot(tx, stored.key("occupied").key(bucket));
          }
        }
      }
      if (next === undefined) {
        deleteIndexSlot(tx, stored.key("assignments").key(memberId));
      } else {
        stored.key("assignments").key(memberId).set({
          bucket: next,
          occurrence,
        });
      }
    },
  );
}
