// Durable-history oracle — INV-1 (read coherence) over a whole space.
//
// `entityConflicts` (conflicts.ts) replays the engine's own admission check
// over one entity's commit history; a hit is by construction an invariant
// violation, since the server validated the same rule before persisting. This
// module lifts that per-entity forensic into a space-wide post-condition so
// concurrency tests can assert "this run produced a coherent store" instead
// of only their hand-written expectations.
//
// See docs/specs/memory-v2/09-invariants.md (INV-1) for the property, and
// test/engine-oracle.test.ts for proof the oracle detects seeded corruption
// (i.e. it is not vacuous).

import type { SpaceDb } from "./db.ts";
import {
  entityConflicts,
  readCoverage,
  readSetsNotKeptIn,
  type StaleRead,
} from "./conflicts.ts";

/** What {@link readCoherence} found, and how much of the space it checked. */
export interface ReadCoherence {
  /** Every anomalous stale read; each is an INV-1 violation. */
  anomalies: StaleRead[];

  /**
   * Commits whose reads the check could not replay: stored with a digest in
   * place of confirmed reads (02-storage.md §3.3), hollowed by compaction,
   * held in a payload that does not show them, holding a read it could not
   * replay or resolve, or reading an entity at a basis older than what
   * compaction kept of the instance read. Empty {@link anomalies} show the
   * store coherent only when this is 0.
   */
  readSetsNotKept: number;
}

/**
 * Replays the engine's confirmed-read admission check over every entity in
 * the space. A healthy store whose commits all keep their reads gives no
 * anomalies and no unchecked read sets; any anomaly is an INV-1 violation (a
 * committed read that the engine's own conflict check would have rejected).
 */
export function readCoherence(
  space: SpaceDb,
  opts: { branch?: string } = {},
): ReadCoherence {
  const ids = space.db
    .prepare(`SELECT DISTINCT id FROM revision ORDER BY id ASC`)
    .all<{ id: string }>();
  // One pass over the log for the whole report, shared by every entity.
  const coverage = readCoverage(space, { everyEntity: true });
  const anomalies: StaleRead[] = [];
  for (const { id } of ids) {
    const { staleReads } = entityConflicts(space, id, { ...opts, coverage });
    for (const staleRead of staleReads) anomalies.push(staleRead);
  }
  return { anomalies, readSetsNotKept: readSetsNotKeptIn(coverage) };
}
