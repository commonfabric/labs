import { toDirtyKey } from "@commonfabric/memory/v2";
import type {
  DemandedInstanceRow,
  SessionDemand,
} from "@commonfabric/memory/v2/server";

/**
 * Builds the per-session shape the memory server's `demandForSpace()` returns
 * out of flat demand rows, for a test that hands a `SpaceServer` its demand
 * directly instead of through client sessions. Rows are grouped by the session
 * their identity names — rows naming none into one group of their own — and
 * each group's rows are keyed by instance key. A key a group names twice is
 * one row, a root if either was.
 *
 * Every call returns new objects, so a `SpaceServer` handed the result on each
 * pass compares every row against what it holds, exactly as it does for a
 * session whose demand the memory server has rebuilt.
 */
export function sessionDemandOf(
  rows: readonly DemandedInstanceRow[],
): SessionDemand[] {
  const sessions = new Map<string, Map<string, DemandedInstanceRow>>();
  for (const row of rows) {
    const sessionId = row.identity?.sessionId ?? "";
    let group = sessions.get(sessionId);
    if (group === undefined) {
      group = new Map();
      sessions.set(sessionId, group);
    }
    const key = toDirtyKey(row.id, row.scopeKey);
    const held = group.get(key);
    group.set(key, { ...row, root: row.root || held?.root === true });
  }
  return [...sessions].map(([sessionId, rows]) => ({ sessionId, rows }));
}
