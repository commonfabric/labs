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

// The spaces a source transaction's split commit closes, in order, recorded
// before the first of them is committed (storage/v2-transaction.ts). Each
// space is committed only once the space before it is accepted.
const splitSpacesBySource = new WeakMap<object, readonly MemorySpace[]>();

/**
 * Records that `source` commits to `spaces` one space at a time, in order. A
 * commit to one space is no split: its acceptance is `source`'s.
 */
export function recordSplitCommitSpaces(
  source: IStorageTransaction,
  spaces: readonly MemorySpace[],
): void {
  if (spaces.length < 2) return;
  splitSpacesBySource.set(source, [...spaces]);
}

/**
 * The client commit sequence of `source`'s commit to `space`, where that
 * commit's acceptance implies all of `source`'s: `source` committed to `space`
 * and to no other space. A split commit closes its spaces one at a time, so
 * none of its commits covers the others, and it has no such sequence.
 * Follow-up work names this commit in its *origin committed* precondition
 * (scheduler-v2 §7.6).
 */
export function getCoveringCommitLocalSeq(
  source: IStorageTransaction | undefined,
  space: MemorySpace,
): number | undefined {
  if (!source || splitSpacesBySource.has(source)) return undefined;
  return getCommitLocalSeq(source, space);
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
