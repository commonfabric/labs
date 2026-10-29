/**
 * What a source transaction's commits are known by after the fact: the
 * per-space client commit sequence each was built with, and the store seq the
 * space accepted each at. The replica records both as they become known and
 * the transaction reads them back, so a caller holding the transaction can
 * name its commit after the replica's bounded ack record has forgotten it.
 */

import type { IStorageTransaction, MemorySpace } from "./interface.ts";

// Per-space client commit sequence numbers recorded for a source
// transaction at commit-build time (storage/v2.ts). Used by speculation
// lineage (scheduler-v2 §7.6) to express the `origin-committed`
// precondition for follow-up work.
const localSeqBySource = new WeakMap<object, Map<MemorySpace, number>>();

// Per-space store sequence numbers recorded for a source transaction when
// its commit's verdict arrives (storage/v2.ts): the position in the space's
// commit log the writes landed at. Read back through the transaction's
// `committedSeq()`.
const seqBySource = new WeakMap<object, Map<MemorySpace, number>>();

function recordBySpace(
  table: WeakMap<object, Map<MemorySpace, number>>,
  source: IStorageTransaction,
  space: MemorySpace,
  value: number,
): void {
  let bySpace = table.get(source);
  if (!bySpace) {
    bySpace = new Map();
    table.set(source, bySpace);
  }
  bySpace.set(space, value);
}

/**
 * Records the client commit sequence `source`'s commit to `space` was built
 * with.
 */
export function recordCommitLocalSeq(
  source: IStorageTransaction,
  space: MemorySpace,
  localSeq: number,
): void {
  recordBySpace(localSeqBySource, source, space, localSeq);
}

/**
 * The client commit sequence `source`'s commit to `space` was built with, if
 * one was recorded.
 */
export function getCommitLocalSeq(
  source: IStorageTransaction | undefined,
  space: MemorySpace,
): number | undefined {
  if (!source) return undefined;
  return localSeqBySource.get(source)?.get(space);
}

/** Records the store seq `space` accepted `source`'s commit at. */
export function recordCommitSeq(
  source: IStorageTransaction,
  space: MemorySpace,
  seq: number,
): void {
  recordBySpace(seqBySource, source, space, seq);
}

/**
 * The store seq `space` accepted `source`'s commit at, once its verdict has
 * arrived.
 */
export function getCommitSeq(
  source: IStorageTransaction | undefined,
  space: MemorySpace,
): number | undefined {
  if (!source) return undefined;
  return seqBySource.get(source)?.get(space);
}
