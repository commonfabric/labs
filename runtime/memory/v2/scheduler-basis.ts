// The engine-side writer of the scheduler_basis index
// (docs/specs/server-side-execution/serving-loop.md §3b). The table is
// created by the engine schema (stage C.2's migration reduced the
// observation tables to it); this module is how a wave's commit step
// records "output current iff these inputs unchanged since these seqs"
// rows for recovery and warm start.
//
// The shape rules §3b binds are enforced here, not left to callers:
//
// - OVERWRITE IN PLACE, per (action, action_scope_key): one run's rows
//   REPLACE that instance's rows as a set. Appending beside a previous
//   run's rows is the evidence log's signature (§8), so the delete half
//   is not optional.
// - Ids + seqs ONLY: the row type carries no payloads and no paths; path
//   precision stays in the in-memory reactivity log.
// - CARRIAGE: the caller invokes this INSIDE the wave's derived store
//   transaction (the sink contract of the runner's wave accumulator, and
//   stage F's loopback commit step). Rows are engine table rows on that
//   transaction — never own commits, never pushed, never read at
//   admission (protocol.md §3, §7).
//
// Stage E feeds instance VALUES through this writer when it re-keys the
// vocabulary per scope instance (plan Phase 1 stage E); at OFF-arm
// cardinality 1 the keys derive from the runtime's own authenticated
// session.

import type { Engine } from "./engine.ts";

/** One basis row: ids + seqs only (serving-loop.md §3b). */
export type SchedulerBasisEntry = {
  entitySpace: string;
  entity: string;
  entityScopeKey: string;

  /** The input's seq at read time, in the entity's own space's sequence;
   * in-wave reads share the wave's own commit seq. */
  seq: number;
};

const DELETE_INSTANCE_ROWS = `
DELETE FROM scheduler_basis
WHERE branch = :branch
  AND action = :action
  AND action_scope_key = :action_scope_key
`;

const INSERT_ROW = `
INSERT INTO scheduler_basis (
  branch, action, action_scope_key,
  entity_space, entity, entity_scope_key, seq
)
VALUES (
  :branch, :action, :action_scope_key,
  :entity_space, :entity, :entity_scope_key, :seq
)
ON CONFLICT (branch, action, action_scope_key,
             entity_space, entity, entity_scope_key)
DO UPDATE SET seq = excluded.seq
`;

/**
 * Replace one (action, action_scope_key) instance's basis rows as a set —
 * the §3b overwrite unit. An empty `rows` array clears the instance
 * (nothing read ⇒ nothing to hold current), which is also the S4
 * narrowing-delete building block: a run whose discovered scope stranded
 * rows under an old instance key clears that key by replacing it with
 * nothing.
 */
export const replaceSchedulerBasisRows = (
  engine: Engine,
  options: {
    branch: string;
    action: string;
    actionScopeKey: string;
    rows: readonly SchedulerBasisEntry[];
  },
): void => {
  const { branch, action, actionScopeKey, rows } = options;
  engine.database.prepare(DELETE_INSTANCE_ROWS).run({
    branch,
    action,
    action_scope_key: actionScopeKey,
  });
  const insert = engine.database.prepare(INSERT_ROW);
  for (const row of rows) {
    insert.run({
      branch,
      action,
      action_scope_key: actionScopeKey,
      entity_space: row.entitySpace,
      entity: row.entity,
      entity_scope_key: row.entityScopeKey,
      seq: row.seq,
    });
  }
};

/** One stale (action, instance) the activation re-mark found: a recorded
 * input seq behind that doc's current head (serving-loop.md §6 step 2). */
export type StaleBasisInstance = {
  action: string;
  actionScopeKey: string;
};

/**
 * The activation/recovery re-mark scan (serving-loop.md §3b, §6 step 2):
 * "a node is dirty iff a recorded input seq is behind that doc's current
 * head." Compares every basis row for inputs in THIS engine's own space
 * against the head table and returns the distinct stale (action,
 * instance) set. Index-guided re-marking, never commit replay.
 *
 * Rows whose `entity_space` is not `space` are cross-space reads
 * (serving-loop.md §3b's foreign-read logging); their heads live in a
 * different engine, so this scan cannot judge them. They are returned
 * separately so the caller can count them; cross-space re-marking lands
 * with the Phase 5 cross-space serving work.
 */
export const selectStaleBasisInstances = (
  engine: Engine,
  options: { branch: string; space: string },
): {
  stale: StaleBasisInstance[];
  foreignReadInstances: StaleBasisInstance[];
} => {
  const stale = engine.database.prepare(`
SELECT DISTINCT b.action AS action, b.action_scope_key AS action_scope_key
FROM scheduler_basis b
LEFT JOIN head h
  ON h.branch = b.branch
 AND h.id = b.entity
 AND h.scope_key = b.entity_scope_key
WHERE b.branch = :branch
  AND b.entity_space = :space
  AND COALESCE(h.seq, 0) > b.seq
ORDER BY b.action, b.action_scope_key
`).all({ branch: options.branch, space: options.space }) as Array<{
    action: string;
    action_scope_key: string;
  }>;
  const foreign = engine.database.prepare(`
SELECT DISTINCT b.action AS action, b.action_scope_key AS action_scope_key
FROM scheduler_basis b
WHERE b.branch = :branch
  AND b.entity_space != :space
ORDER BY b.action, b.action_scope_key
`).all({ branch: options.branch, space: options.space }) as Array<{
    action: string;
    action_scope_key: string;
  }>;
  const shape = (rows: Array<{ action: string; action_scope_key: string }>) =>
    rows.map((row) => ({
      action: row.action,
      actionScopeKey: row.action_scope_key,
    }));
  return { stale: shape(stale), foreignReadInstances: shape(foreign) };
};

/** One cross-space basis row (Phase 5's foreign re-mark): the recorded
 * foreign input plus its owning (action, instance), so the activation
 * scan can compare the recorded seq against the FOREIGN space's head
 * through that space's own co-hosted engine (serving-loop.md §3b's
 * foreign-read logging; §6 step 2). */
export type ForeignBasisRow = SchedulerBasisEntry & StaleBasisInstance;

/**
 * Every basis row whose recorded input lives in ANOTHER space
 * (serving-loop.md §3b's cross-space bullet). The caller judges
 * staleness against each entity_space's own engine — this engine cannot
 * (its head table holds only its own docs).
 */
export const selectForeignBasisRows = (
  engine: Engine,
  options: { branch: string; space: string },
): ForeignBasisRow[] => {
  const rows = engine.database.prepare(`
SELECT action, action_scope_key, entity_space, entity, entity_scope_key, seq
FROM scheduler_basis
WHERE branch = :branch
  AND entity_space != :space
ORDER BY action, action_scope_key, entity_space, entity, entity_scope_key
`).all({ branch: options.branch, space: options.space }) as Array<{
    action: string;
    action_scope_key: string;
    entity_space: string;
    entity: string;
    entity_scope_key: string;
    seq: number;
  }>;
  return rows.map((row) => ({
    action: row.action,
    actionScopeKey: row.action_scope_key,
    entitySpace: row.entity_space,
    entity: row.entity,
    entityScopeKey: row.entity_scope_key,
    seq: row.seq,
  }));
};

/** Read one instance's rows back (recovery's re-mark scan, and tests). */
export const selectSchedulerBasisRows = (
  engine: Engine,
  options: { branch: string; action: string; actionScopeKey: string },
): Array<SchedulerBasisEntry> => {
  const rows = engine.database.prepare(`
SELECT entity_space, entity, entity_scope_key, seq
FROM scheduler_basis
WHERE branch = :branch
  AND action = :action
  AND action_scope_key = :action_scope_key
ORDER BY entity_space, entity, entity_scope_key
`).all({
      branch: options.branch,
      action: options.action,
      action_scope_key: options.actionScopeKey,
    }) as Array<{
      entity_space: string;
      entity: string;
      entity_scope_key: string;
      seq: number;
    }>;
  return rows.map((row) => ({
    entitySpace: row.entity_space,
    entity: row.entity,
    entityScopeKey: row.entity_scope_key,
    seq: row.seq,
  }));
};
