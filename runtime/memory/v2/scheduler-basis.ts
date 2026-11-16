// The engine-side writer of the scheduler_basis index
// (docs/specs/server-side-execution/serving-loop.md §3b). The table is
// created by the engine schema (stage C.2's migration reduced the
// observation tables to it); this module is how a wave's commit step
// records "output current iff these inputs unchanged since these seqs"
// rows. Nothing reads them back outside tests.
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
  engine.prepare(DELETE_INSTANCE_ROWS).run({
    branch,
    action,
    action_scope_key: actionScopeKey,
  });
  const insert = engine.prepare(INSERT_ROW);
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

/** Reads one instance's rows back. */
export const selectSchedulerBasisRows = (
  engine: Engine,
  options: { branch: string; action: string; actionScopeKey: string },
): Array<SchedulerBasisEntry> => {
  const rows = engine.prepare(`
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
