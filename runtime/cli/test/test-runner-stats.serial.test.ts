/**
 * The verbose statistics `cf test` prints: settle iterations, storage logger
 * activity, scheduler action totals, and the runs one step caused.
 */

import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import {
  getLogger,
  resetAllLoggerCounts,
  resetAllTimingStats,
} from "@commonfabric/logger";
import type { SchedulerGraphNode, SettleStats } from "@commonfabric/runner";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import {
  printActionStatsTable,
  printRunDeltas,
  printSettleStats,
  printStorageStats,
} from "../lib/test-runner.ts";

/** Each line `console.log` receives during `run`, its runs of spaces collapsed. */
function printed(run: () => void): string[] {
  const output: string[] = [];
  const log = stub(console, "log", (...args: unknown[]) => {
    output.push(args.map(String).join(" ").replace(/\s+/g, " ").trim());
  });
  try {
    run();
  } finally {
    log.restore();
  }
  return output;
}

/** A graph node that ran `runCount` times for `totalTime` milliseconds. */
function ran(
  id: string,
  runCount: number,
  totalTime: number,
  extra: Partial<SchedulerGraphNode> = {},
): SchedulerGraphNode {
  return {
    id,
    type: "computation",
    isDirty: false,
    isPending: false,
    stats: {
      runCount,
      totalTime,
      averageTime: totalTime / runCount,
      lastRunTime: totalTime / runCount,
      lastRunTimestamp: 0,
    },
    ...extra,
  };
}

describe("test-runner-stats", () => {
  describe("printSettleStats()", () => {
    it("prints nothing for absent stats or a single iteration", () => {
      const single: SettleStats = {
        iterations: [{
          workSetSize: 1,
          orderSize: 1,
          actionsRun: 1,
          actions: [{ id: "only", type: "effect" }],
          durationMs: 1,
        }],
        totalDurationMs: 1,
        settledEarly: true,
        initialSeedCount: 1,
      };
      expect(printed(() => printSettleStats(null))).toEqual([]);
      expect(printed(() => printSettleStats(single))).toEqual([]);
    });

    it("prints each iteration and the work set of a small one, shortening long action ids", () => {
      const longId = "x".repeat(80);
      const stats: SettleStats = {
        iterations: [
          {
            workSetSize: 2,
            orderSize: 2,
            actionsRun: 2,
            actions: [
              { id: "short-effect", type: "effect" },
              { id: longId, type: "computation" },
            ],
            durationMs: 12,
          },
          {
            workSetSize: 41,
            orderSize: 41,
            actionsRun: 0,
            actions: [{ id: "hidden", type: "effect" }],
            durationMs: 0.5,
          },
        ],
        totalDurationMs: 1500,
        settledEarly: false,
        initialSeedCount: 3,
      };
      expect(printed(() => printSettleStats(stats))).toEqual([
        "Settle: 2 iterations, 1.5s, 3 initial seeds, settled=false",
        "iter 0: workSet=2 order=2 (1E 1C), ran=2, 12ms",
        "[E] short-effect",
        `[C] ${"x".repeat(67)}...`,
        "iter 1: workSet=41 order=41 (1E 0C), ran=0, 0.50ms",
      ]);
    });
  });

  describe("printStorageStats()", () => {
    const storage = getLogger("storage-stats-test", { enabled: false });
    const other = getLogger("other-stats-test", { enabled: false });

    beforeEach(() => {
      resetAllLoggerCounts();
      resetAllTimingStats();
    });

    afterEach(() => {
      resetAllLoggerCounts();
      resetAllTimingStats();
    });

    it("prints only its heading when no storage logger was active", () => {
      other.info("busy", "not storage");
      other.time(0, 30, "busy");
      expect(printed(() => printStorageStats(2500))).toEqual([
        "🗄 2.5s | Storage totals:",
      ]);
    });

    it("prints the storage loggers' timings, counts, and per-key counts, leaving out other loggers", () => {
      storage.debug("read", "d");
      storage.info("read", "i");
      storage.warn("write", "w");
      storage.error("write", "e");
      storage.error("write", "e");
      storage.time(0, 2.5, "read");
      other.error("busy", "not storage");
      other.time(0, 30, "busy");

      expect(printed(() => printStorageStats(12))).toEqual([
        "🗄 12ms | Storage totals:",
        "Timings (top 1 by p95):",
        "storage-stats-test/read n= 1 p50= 2.5ms p95= 2.5ms max= 2.5ms",
        "Counts (all storage loggers):",
        "storage-stats-test n= 5 (d:1 i:1 w:1 e:2)",
        "Count keys (top 2):",
        "storage-stats-test/write n= 3 (w:1 e:2)",
        "storage-stats-test/read n= 2 (d:1 i:1)",
      ]);
    });

    it("keeps the slowest timings and busiest keys up to its limit", () => {
      storage.time(0, 1, "fast");
      storage.time(0, 30, "slow");
      storage.info("quiet", "once");
      storage.info("busy", "one");
      storage.info("busy", "two");

      const output = printed(() => printStorageStats(0, 1));
      expect(output).toContain("Timings (top 1 by p95):");
      expect(output).toContain(
        "storage-stats-test/slow n= 1 p50= 30ms p95= 30ms max= 30ms",
      );
      expect(output.some((line) => line.includes("/fast"))).toBe(false);
      expect(output).toContain("Count keys (top 1):");
      expect(output).toContain("storage-stats-test/busy n= 2 (i:2)");
      expect(output.some((line) => line.includes("/quiet"))).toBe(false);
    });
  });

  describe("printActionStatsTable()", () => {
    it("prints nothing when no action has run", () => {
      const idle: SchedulerGraphNode = {
        id: "never",
        type: "effect",
        isDirty: false,
        isPending: false,
      };
      expect(
        printed(() => printActionStatsTable([idle, ran("zero", 0, 0)])),
      ).toEqual([]);
    });

    it("merges actions sharing an id and folds a child into its parent's row", () => {
      const output = printed(() =>
        printActionStatsTable([
          ran("shared", 1, 4, { preview: "  computeShared()\nsecond line" }),
          ran("shared", 1, 4),
          ran("parent", 1, 2),
          ran("child", 2, 3, { parentId: "parent" }),
        ])
      );
      expect(output).toEqual([
        "⚡ Action Stats (top 20 by total time):",
        "Action Runs Total Avg Last",
        "─".repeat(90),
        "parent (+1ch) 3 5.0ms 1.7ms 2.0ms",
        "computeShared() (2x) 1 4.0ms 4.0ms 4.0ms",
        "─".repeat(90),
        "TOTAL 4 9.0ms",
      ]);
    });

    it("keeps the end of a label longer than its column", () => {
      const id = `${"a".repeat(30)}${"z".repeat(30)}`;
      const output = printed(() => printActionStatsTable([ran(id, 1, 1)]));
      expect(output).toContain(
        `…${"a".repeat(23)}${"z".repeat(30)} 1 1.0ms 1.0ms 1.0ms`,
      );
    });
  });

  describe("printRunDeltas()", () => {
    it("prints nothing when no action ran since the counts were taken", () => {
      const output = printed(() =>
        printRunDeltas(new Map([["same", 2]]), [ran("same", 2, 1)], 10)
      );
      expect(output).toEqual([]);
    });

    it("prints each action's new runs with the cells it reads and writes", () => {
      const output = printed(() =>
        printRunDeltas(
          new Map([["counted", 1]]),
          [
            ran("counted", 4, 1, {
              preview: "  ({ count }) => count + 1\nrest",
              reads: [
                "did:key:z/of:fid1:abcdefghijkl/value/count",
                "did:key:z/of:fid1:abcdefghijkl/value/count",
                "did:key:z/of:short/value",
                "did:key:z/of:loneentityidentifier",
                "plain",
              ],
              writes: ["did:key:z/of:fid1:mnopqrstuv/value", "a", "b"],
            }),
            ran("counted", 9, 1),
            ran("schema-only", 2, 1, {
              reads: ["did:key:z/of:q/%22query%22", "did:key:z/of:q/x"],
            }),
          ],
          10,
        )
      );
      expect(output).toEqual([
        "⟳ 5 scheduler runs across 2 actions:",
        "3× ({ count }) => count + 1 r:[fid1:abc…/value/count, fid1:abc…/value/count, short/value +2] w:[fid1:mno…/value, a +1]",
        "2× schema-only r:[q/x]",
        "📖 Most-read entities:",
        "6× fid1:abc…/value/count",
        "3× short…/value",
        "3× loneenti…",
        "2× q…/x",
      ]);
    });

    it("shortens a read with no entity path or no entity", () => {
      const longPlain = `plain-${"p".repeat(50)}`;
      const output = printed(() =>
        printRunDeltas(
          new Map(),
          [ran("r", 1, 1, {
            reads: ["did:key:z/of:loneentityidentifier-long", longPlain],
          })],
          10,
        )
      );
      expect(output[1]).toBe(
        `1× r r:[…ntityidentifier-long, …${longPlain.slice(-39)}]`,
      );
    });

    it("prints a schema-query placeholder for an action whose reads are all schema queries", () => {
      const output = printed(() =>
        printRunDeltas(
          new Map(),
          [ran("q", 1, 1, {
            reads: [
              "did:key:z/of:q/%22query%22/a",
              "did:key:z/of:q/%22query%22/b",
            ],
          })],
          10,
        )
      );
      expect(output).toEqual([
        "⟳ 1 scheduler runs across 1 actions:",
        "1× q r:[schema-query +1]",
      ]);
    });

    it("totals the actions beyond its limit on one line", () => {
      const output = printed(() =>
        printRunDeltas(
          new Map(),
          [ran("most", 5, 1), ran("next", 2, 1), ran("least", 1, 1)],
          1,
        )
      );
      expect(output).toEqual([
        "⟳ 8 scheduler runs across 3 actions:",
        "5× most",
        "3× (2 more actions)",
      ]);
    });
  });
});
