import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { GraphNodeInfo } from "../src/lib/scheduler-graph-layout.ts";
import {
  captureBaseline,
  formatDelta,
  formatDuration,
  graphTotals,
  type TableGroup,
  tableGroups,
  type TableSort,
} from "../src/lib/scheduler-graph-stats.ts";

/**
 * A computation for `id` that ran `runCount` times for `totalTime`
 * milliseconds in all, the last run taking `lastTime`.
 */
function ranNode(
  id: string,
  runCount: number,
  totalTime: number,
  extra: Partial<GraphNodeInfo> & { lastTime?: number } = {},
): GraphNodeInfo {
  const { lastTime = 1, ...rest } = extra;
  return {
    id,
    label: id,
    fullId: id,
    type: "computation",
    isDirty: false,
    isPending: false,
    stats: {
      runCount,
      totalTime,
      averageTime: totalTime / runCount,
      lastRunTime: lastTime,
      lastRunTimestamp: 0,
    },
    ...rest,
  };
}

/** The ids of the groups, each followed by the ids of its children. */
function order(groups: TableGroup[]): string[][] {
  return groups.map((g) => [g.node.id, ...g.children.map((c) => c.node.id)]);
}

const BY_TOTAL: TableSort = {
  column: "totalTime",
  ascending: false,
  byDelta: false,
};

describe("scheduler-graph-stats", () => {
  describe("formatDuration()", () => {
    it("returns microseconds below a millisecond, seconds from a second, and milliseconds between", () => {
      expect(formatDuration(0.25)).toBe("250µs");
      expect(formatDuration(12.34)).toBe("12.3ms");
      expect(formatDuration(999)).toBe("999.0ms");
      expect(formatDuration(1500)).toBe("1.50s");
    });

    it("returns a negative duration in the unit its size calls for", () => {
      expect(formatDuration(-0.25)).toBe("-250µs");
      expect(formatDuration(-12.34)).toBe("-12.3ms");
      expect(formatDuration(-1500)).toBe("-1.50s");
    });

    it("returns `-` for zero, or what it is given for zero", () => {
      expect(formatDuration(0)).toBe("-");
      expect(formatDuration(0, "")).toBe("");
      expect(formatDuration(0.25, "")).toBe("250µs");
    });
  });

  describe("formatDelta()", () => {
    it("returns a count signed", () => {
      expect(formatDelta(3)).toBe("+3");
      expect(formatDelta(-2)).toBe("-2");
    });

    it("returns a duration signed, in the unit its size calls for", () => {
      expect(formatDelta(0.5, true)).toBe("+500µs");
      expect(formatDelta(-0.5, true)).toBe("-500µs");
      expect(formatDelta(12.34, true)).toBe("+12.3ms");
      expect(formatDelta(-2500, true)).toBe("-2.50s");
    });

    it("returns the empty string for no change", () => {
      expect(formatDelta(0)).toBe("");
      expect(formatDelta(0, true)).toBe("");
    });
  });

  describe("captureBaseline()", () => {
    it("returns the run count and total time of each node that has stats", () => {
      const idle = { ...ranNode("idle", 1, 1), stats: undefined };

      expect(captureBaseline([ranNode("a", 3, 6), idle])).toEqual(
        new Map([["a", { runCount: 3, totalTime: 6 }]]),
      );
    });
  });

  describe("graphTotals()", () => {
    it("returns the runs and time summed, and their change since the baseline", () => {
      const idle = { ...ranNode("idle", 1, 1), stats: undefined };
      const baseline = new Map([["a", { runCount: 1, totalTime: 2 }]]);

      expect(
        graphTotals([ranNode("a", 3, 6), ranNode("b", 2, 4), idle], baseline),
      ).toEqual({ runCount: 5, totalTime: 10, runDelta: 4, timeDelta: 8 });
    });
  });

  describe("tableGroups()", () => {
    it("returns a row for each action with stats, leaving out inputs and actions that never ran", () => {
      const nodes = [
        ranNode("a", 1, 1),
        ranNode("input:x", 1, 1, { type: "input" }),
        { ...ranNode("idle", 1, 1), stats: undefined },
      ];

      expect(order(tableGroups(nodes, new Map(), BY_TOTAL))).toEqual([["a"]]);
    });

    it("returns each row whose parent has a row under that row, summing the two", () => {
      const groups = tableGroups(
        [
          ranNode("parent", 1, 10),
          ranNode("child", 2, 5, { parentId: "parent" }),
          ranNode("orphan", 4, 1, { parentId: "absent" }),
        ],
        new Map([["child", { runCount: 1, totalTime: 1 }]]),
        BY_TOTAL,
      );

      expect(order(groups)).toEqual([["parent", "child"], ["orphan"]]);
      expect(groups[0].aggregate).toEqual({
        runCount: 3,
        totalTime: 15,
        avgTime: 10,
        lastTime: 1,
        runDelta: 2,
        timeDelta: 14,
      });
      expect(groups[0].children[0]).toMatchObject({
        runDelta: 1,
        timeDelta: 4,
      });
    });

    it("returns every descendant's row under its outermost ancestor with a row, summing them all", () => {
      // `q` never ran, so it has no row, and `r` goes under `g` past it.
      const groups = tableGroups(
        [
          ranNode("g", 1, 10),
          ranNode("p", 2, 5, { parentId: "g" }),
          ranNode("c", 4, 2, { parentId: "p" }),
          { ...ranNode("q", 1, 1, { parentId: "g" }), stats: undefined },
          ranNode("r", 8, 3, { parentId: "q" }),
        ],
        new Map(),
        BY_TOTAL,
      );

      expect(order(groups)).toEqual([["g", "p", "r", "c"]]);
      expect(groups[0].aggregate).toMatchObject({
        runCount: 15,
        totalTime: 20,
      });
    });

    it("returns the groups sorted by their summed figures, largest first", () => {
      const nodes = [
        ranNode("a", 1, 10),
        ranNode("b", 1, 8),
        ranNode("b1", 5, 4, { parentId: "b" }),
      ];

      expect(order(tableGroups(nodes, new Map(), BY_TOTAL))).toEqual([
        ["b", "b1"],
        ["a"],
      ]);
      expect(
        order(
          tableGroups(nodes, new Map(), { ...BY_TOTAL, column: "runCount" }),
        ),
      ).toEqual([["b", "b1"], ["a"]]);
    });

    it("returns the groups sorted by their own average or last time, not the summed", () => {
      const nodes = [
        ranNode("a", 1, 10, { lastTime: 3 }),
        ranNode("b", 1, 8, { lastTime: 2 }),
        ranNode("b1", 1, 40, { parentId: "b", lastTime: 9 }),
      ];

      expect(
        order(
          tableGroups(nodes, new Map(), { ...BY_TOTAL, column: "avgTime" }),
        ).map((g) => g[0]),
      ).toEqual(["a", "b"]);
      expect(
        order(
          tableGroups(nodes, new Map(), { ...BY_TOTAL, column: "lastTime" }),
        ).map((g) => g[0]),
      ).toEqual(["a", "b"]);
    });

    it("returns the rows sorted smallest first when ascending", () => {
      const nodes = [ranNode("a", 1, 10), ranNode("b", 1, 8)];

      expect(
        order(tableGroups(nodes, new Map(), { ...BY_TOTAL, ascending: true })),
      ).toEqual([["b"], ["a"]]);
    });

    it("returns the children sorted by the same column", () => {
      const nodes = [
        ranNode("p", 1, 1),
        ranNode("small", 9, 2, { parentId: "p" }),
        ranNode("large", 1, 5, { parentId: "p" }),
      ];

      expect(order(tableGroups(nodes, new Map(), BY_TOTAL))).toEqual([
        ["p", "large", "small"],
      ]);
      expect(
        order(
          tableGroups(nodes, new Map(), { ...BY_TOTAL, column: "runCount" }),
        ),
      ).toEqual([["p", "small", "large"]]);
    });

    describe("sorting by delta", () => {
      // `a` has more in all, and `b` has gained more since the baseline.

      const nodes = [
        ranNode("a", 10, 100),
        ranNode("b", 6, 50),
        ranNode("p", 1, 1),
        ranNode("old", 10, 100, { parentId: "p" }),
        ranNode("new", 6, 50, { parentId: "p" }),
      ];
      const baseline = new Map([
        ["a", { runCount: 9, totalTime: 99 }],
        ["old", { runCount: 9, totalTime: 99 }],
      ]);

      it("returns the rows sorted by their change since the baseline", () => {
        expect(
          order(tableGroups(nodes, baseline, { ...BY_TOTAL, byDelta: true })),
        ).toEqual([["p", "new", "old"], ["b"], ["a"]]);
        expect(
          order(
            tableGroups(nodes, baseline, {
              column: "runCount",
              ascending: false,
              byDelta: true,
            }),
          ),
        ).toEqual([["p", "new", "old"], ["b"], ["a"]]);
      });

      it("returns the rows sorted by their totals when there is no baseline", () => {
        expect(
          order(
            tableGroups(nodes, new Map(), { ...BY_TOTAL, byDelta: true }),
          ),
        ).toEqual([["p", "old", "new"], ["a"], ["b"]]);
      });
    });
  });
});
