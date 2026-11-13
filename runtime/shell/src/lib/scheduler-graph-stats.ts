/**
 * The run statistics the scheduler graph view, `x-scheduler-graph`, shows:
 * how a duration and a change since the baseline read, the totals over the
 * whole graph, and the rows of the table view, grouped under their top-level
 * ancestors and sorted.
 */

import type { GraphNodeInfo } from "./scheduler-graph-layout.ts";

/** An action's run count and total run time. */
export interface RunTotals {
  runCount: number;

  /** In milliseconds. */
  totalTime: number;
}

/**
 * The run totals of each action at the moment the user last reset the
 * baseline, keyed by action id.
 */
export type RunBaseline = ReadonlyMap<string, RunTotals>;

/** A column the table view can be sorted by. */
export type TableSortColumn = "totalTime" | "runCount" | "avgTime" | "lastTime";

/** How the table view is sorted. */
export interface TableSort {
  column: TableSortColumn;

  /** Smallest first, rather than largest first. */
  ascending: boolean;

  /**
   * Sort the run count and total time columns by their change since the
   * baseline. With no baseline, each change is the figure itself.
   */
  byDelta: boolean;
}

/** The figures of one row of the table view. */
export interface TableFigures {
  runCount: number;

  /** Total run time, in milliseconds. */
  totalTime: number;

  /** Average run time, in milliseconds. */
  avgTime: number;

  /** Time the last run took, in milliseconds. */
  lastTime: number;

  /** Change in `runCount` since the baseline. */
  runDelta: number;

  /** Change in `totalTime` since the baseline. */
  timeDelta: number;
}

/** One action's row of the table view. */
export interface TableRow extends TableFigures {
  node: GraphNodeInfo;
}

/** A top-level row of the table view, with the rows of its descendants. */
export interface TableGroup extends TableRow {
  /** The rows of the descendants, of every generation, sorted. */
  children: TableRow[];

  /**
   * The figures of the row and its descendants together: the run counts and
   * total times summed, and the average and last times of the row alone.
   */
  aggregate: TableFigures;
}

/** Run counts and total times summed over a graph. */
export interface GraphTotals {
  runCount: number;

  /** In milliseconds. */
  totalTime: number;

  /** Change in `runCount` since the baseline. */
  runDelta: number;

  /** Change in `totalTime` since the baseline. */
  timeDelta: number;
}

/**
 * Returns a duration given in milliseconds as microseconds where its size is
 * below one millisecond, as seconds from one second up, and as milliseconds
 * between. Zero is `zero`.
 */
export function formatDuration(ms: number, zero = "-"): string {
  if (ms === 0) return zero;
  const size = Math.abs(ms);
  if (size < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (size < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Returns a change, signed, as `formatDuration()` shows it when `isTime`, and
 * as a plain count otherwise; no change is the empty string.
 */
export function formatDelta(delta: number, isTime = false): string {
  if (delta === 0) return "";
  const sign = delta > 0 ? "+" : "";
  return sign + (isTime ? formatDuration(delta) : String(delta));
}

/** Returns the run count and total time of each node that has stats. */
export function captureBaseline(
  nodes: Iterable<GraphNodeInfo>,
): Map<string, RunTotals> {
  const baseline = new Map<string, RunTotals>();
  for (const { id, stats } of nodes) {
    if (stats) {
      baseline.set(id, {
        runCount: stats.runCount,
        totalTime: stats.totalTime,
      });
    }
  }
  return baseline;
}

/**
 * Returns the run counts and total times of the nodes that have stats,
 * summed, along with their change since `baseline`. A node with no baseline
 * entry counts as having started from zero.
 */
export function graphTotals(
  nodes: Iterable<GraphNodeInfo>,
  baseline: RunBaseline,
): GraphTotals {
  const totals = { runCount: 0, totalTime: 0, runDelta: 0, timeDelta: 0 };
  for (const node of nodes) {
    if (!node.stats) continue;
    const row = tableRow(node, baseline);
    totals.runCount += row.runCount;
    totals.totalTime += row.totalTime;
    totals.runDelta += row.runDelta;
    totals.timeDelta += row.timeDelta;
  }
  return totals;
}

/**
 * Returns the rows of the table view: one for each node that has stats and is
 * not an input, with each node that has an ancestor with a row grouped under
 * the row of its outermost such ancestor, and both levels sorted by `sort`.
 * Ties keep the order of `nodes`. The parents of `nodes` must form no cycle,
 * as `layoutSchedulerGraph()` makes sure of.
 */
export function tableGroups(
  nodes: Iterable<GraphNodeInfo>,
  baseline: RunBaseline,
  sort: TableSort,
): TableGroup[] {
  const all = [...nodes];
  const parentIds = new Map(all.map((n) => [n.id, n.parentId]));
  const rows = all
    .filter((n) => n.type !== "input" && n.stats)
    .map((n) => tableRow(n, baseline));
  const ids = new Set(rows.map((row) => row.node.id));
  const descendantsByGroup = new Map<string, TableRow[]>();
  const topLevel: TableRow[] = [];
  for (const row of rows) {
    let groupId: string | undefined;
    for (
      let ancestor = row.node.parentId;
      ancestor !== undefined;
      ancestor = parentIds.get(ancestor)
    ) {
      if (ids.has(ancestor)) groupId = ancestor;
    }
    if (groupId === undefined) {
      topLevel.push(row);
    } else {
      const members = descendantsByGroup.get(groupId);
      if (members) members.push(row);
      else descendantsByGroup.set(groupId, [row]);
    }
  }

  const compare = (a: TableFigures, b: TableFigures) => {
    const cmp = sort.column === "totalTime"
      ? sort.byDelta ? b.timeDelta - a.timeDelta : b.totalTime - a.totalTime
      : sort.column === "runCount"
      ? sort.byDelta ? b.runDelta - a.runDelta : b.runCount - a.runCount
      : b[sort.column] - a[sort.column];
    return sort.ascending ? -cmp : cmp;
  };

  const groups = topLevel.map((row) => {
    const children = descendantsByGroup.get(row.node.id) ?? [];
    const sum = (key: "runCount" | "totalTime" | "runDelta" | "timeDelta") =>
      children.reduce((total, c) => total + c[key], row[key]);
    return {
      ...row,
      children: children.sort(compare),
      aggregate: {
        runCount: sum("runCount"),
        totalTime: sum("totalTime"),
        avgTime: row.avgTime,
        lastTime: row.lastTime,
        runDelta: sum("runDelta"),
        timeDelta: sum("timeDelta"),
      },
    };
  });
  return groups.sort((a, b) => compare(a.aggregate, b.aggregate));
}

/** Helper for `tableGroups()` and `graphTotals()`, which builds one row. */
function tableRow(node: GraphNodeInfo, baseline: RunBaseline): TableRow {
  const runCount = node.stats?.runCount ?? 0;
  const totalTime = node.stats?.totalTime ?? 0;
  const base = baseline.get(node.id);
  return {
    node,
    runCount,
    totalTime,
    avgTime: node.stats?.averageTime ?? 0,
    lastTime: node.stats?.lastRunTime ?? 0,
    runDelta: runCount - (base?.runCount ?? 0),
    timeDelta: totalTime - (base?.totalTime ?? 0),
  };
}
