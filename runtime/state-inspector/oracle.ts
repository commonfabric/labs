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
  readSetsNotKept,
  type StaleRead,
} from "./conflicts.ts";

/** What {@link readCoherence} found, and how much of the space it checked. */
export interface ReadCoherence {
  /** Every anomalous stale read; each is an INV-1 violation. */
  anomalies: StaleRead[];

  /**
   * Commits the log holds with a digest in place of their reads
   * (02-storage.md §3.3), which the check cannot replay. Empty
   * {@link anomalies} show the store coherent only when this is 0.
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
  const anomalies: StaleRead[] = [];
  for (const { id } of ids) {
    for (const staleRead of entityConflicts(space, id, opts).staleReads) {
      anomalies.push(staleRead);
    }
  }
  return { anomalies, readSetsNotKept: readSetsNotKept(space) };
}
