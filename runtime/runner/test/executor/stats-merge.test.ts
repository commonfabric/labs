import { expect } from "@std/expect";
import {
  DERIVED_COMMITS_BY_SPACE_MAX,
  emptyServingLoopStats,
  type ServingActionCost,
  type ServingLoopStats,
  SETTLE_SERIES_MAX,
} from "../../src/executor/stats.ts";
import {
  closedHostServingLoopStats,
  mergeServingLoopStats,
} from "../../src/executor/stats-merge.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** The counters of a host with nothing counted, with `over` laid over them. */
const statsWith = (over: Partial<ServingLoopStats>): ServingLoopStats => ({
  ...emptyServingLoopStats(),
  ...over,
});

/** The cost of `runs` runs of `action` of `space` that took `ms` in all. */
const actionCost = (
  space: string,
  action: string,
  ms: number,
  runs = 1,
): ServingActionCost => ({
  space,
  action,
  runs,
  inputRuns: 0,
  totalMs: ms,
  longestMs: ms,
  lastMs: ms,
});

/** A settle-advance row of `space` that advanced to `to`. */
const advance = (space: string, to: number) => ({
  space,
  from: to - 1,
  to,
  at: to,
});

describe("stats-merge", () => {
  describe("mergeServingLoopStats()", () => {
    it("returns the counters of no host for an empty list", () => {
      expect(mergeServingLoopStats([])).toEqual(emptyServingLoopStats());
    });

    it("adds counters, at the top level and inside a block", () => {
      const merged = mergeServingLoopStats([
        statsWith({
          waves: 2,
          lease: { held: 3, lost: 1 },
          events: { ...emptyServingLoopStats().events, appended: 4 },
        }),
        statsWith({
          waves: 5,
          lease: { held: 1, lost: 0 },
          events: { ...emptyServingLoopStats().events, appended: 6 },
        }),
      ]);
      expect(merged.waves).toBe(7);
      expect(merged.lease).toEqual({ held: 4, lost: 1 });
      expect(merged.events.appended).toBe(10);
    });

    it("adds the levels hosts hold now", () => {
      const merged = mergeServingLoopStats([
        statsWith({
          activeSpaces: 1,
          memo: { hits: 0, misses: 0, inflight: 2 },
        }),
        statsWith({
          activeSpaces: 2,
          memo: { hits: 0, misses: 0, inflight: 3 },
        }),
      ]);
      expect(merged.activeSpaces).toBe(3);
      expect(merged.memo.inflight).toBe(5);
    });

    it("takes the largest of a peak and of a largest-held level", () => {
      const demand = emptyServingLoopStats().demand;
      const merged = mergeServingLoopStats([
        statsWith({
          watermarkLag: 4,
          demand: { ...demand, demandedInstancesMax: 9 },
        }),
        statsWith({
          watermarkLag: 7,
          demand: { ...demand, demandedInstancesMax: 5 },
        }),
      ]);
      expect(merged.watermarkLag).toBe(7);
      expect(merged.demand.demandedInstancesMax).toBe(9);
    });

    it("adds per-space derived commits space by space", () => {
      const merged = mergeServingLoopStats([
        statsWith({ derivedCommitsBySpace: { a: 1, b: 2 } }),
        statsWith({ derivedCommitsBySpace: { b: 3, c: 4 } }),
      ]);
      expect(merged.derivedCommitsBySpace).toEqual({ a: 1, b: 5, c: 4 });
    });

    it("folds the earliest-listed spaces beyond the cap on per-space rows into the dropped count", () => {
      const rows = (prefix: string, count: number) =>
        Object.fromEntries(
          Array.from({ length: count }, (_, index) => [`${prefix}${index}`, 1]),
        );
      const merged = mergeServingLoopStats([
        statsWith({ derivedCommitsBySpace: rows("first-", 3) }),
        statsWith({
          derivedCommitsBySpace: rows("second-", DERIVED_COMMITS_BY_SPACE_MAX),
        }),
      ]);
      expect(Object.keys(merged.derivedCommitsBySpace)).toHaveLength(
        DERIVED_COMMITS_BY_SPACE_MAX,
      );
      expect(merged.derivedCommitsBySpace["first-0"]).toBeUndefined();
      expect(merged.derivedCommitsBySpace["second-0"]).toBe(1);
      expect(merged.derivedCommitsBySpaceDropped).toBe(3);
    });

    it("joins a series end to end in the order of the parts", () => {
      const merged = mergeServingLoopStats([
        statsWith({
          settleAdvances: {
            count: 1,
            lastDelta: 1,
            series: [advance("a", 1)],
            dropped: 2,
          },
        }),
        statsWith({
          settleAdvances: {
            count: 1,
            lastDelta: 3,
            series: [advance("b", 9)],
            dropped: 0,
          },
        }),
      ]);
      expect(merged.settleAdvances).toEqual({
        count: 2,
        lastDelta: 3,
        series: [advance("a", 1), advance("b", 9)],
        dropped: 2,
      });
    });

    it("keeps the last delta of the last part that advanced", () => {
      const merged = mergeServingLoopStats([
        statsWith({
          settleAdvances: { count: 1, lastDelta: 5, series: [], dropped: 0 },
        }),
        emptyServingLoopStats(),
      ]);
      expect(merged.settleAdvances.lastDelta).toBe(5);
    });

    it("drops the earliest rows of a series beyond its bound, and counts them dropped", () => {
      const series = (space: string) =>
        Array.from(
          { length: SETTLE_SERIES_MAX },
          (_, index) => advance(space, index),
        );
      const merged = mergeServingLoopStats([
        statsWith({
          settleAdvances: {
            count: 0,
            lastDelta: 0,
            series: series("a"),
            dropped: 0,
          },
        }),
        statsWith({
          settleAdvances: {
            count: 0,
            lastDelta: 0,
            series: series("b").slice(0, 10),
            dropped: 0,
          },
        }),
      ]);
      expect(merged.settleAdvances.series).toHaveLength(SETTLE_SERIES_MAX);
      expect(merged.settleAdvances.series[0]).toEqual(advance("a", 10));
      expect(merged.settleAdvances.series.at(-1)).toEqual(advance("b", 9));
      expect(merged.settleAdvances.dropped).toBe(10);
    });

    it("takes the action costs of every host together, one row per action of a space, most expensive first", () => {
      const merged = mergeServingLoopStats([
        statsWith({
          actions: {
            entries: [actionCost("did:a", "sum", 3)],
            dropped: 1,
            droppedMs: 2,
          },
        }),
        statsWith({
          actions: {
            entries: [
              actionCost("did:a", "sum", 4),
              actionCost("did:b", "sum", 9),
            ],
            dropped: 0,
            droppedMs: 0,
          },
        }),
      ]);
      expect(
        merged.actions.entries.map(({ space, totalMs, runs }) => [
          space,
          totalMs,
          runs,
        ]),
      ).toEqual([["did:b", 9, 1], ["did:a", 7, 2]]);
      expect(merged.actions.dropped).toBe(1);
      expect(merged.actions.droppedMs).toBe(2);
    });

    it("returns counters that share nothing a part's holder writes to", () => {
      const part = statsWith({
        derivedCommitsBySpace: { a: 1 },
        settle: {
          series: [{
            space: "a",
            seq: 1,
            admittedAt: 0,
            coveredAt: 2,
            ms: 2,
            waves: 1,
            cycles: 1,
            growthWakes: 0,
            class: "value-only",
            eventAppend: false,
          }],
          dropped: 0,
        },
        settleAdvances: {
          count: 1,
          lastDelta: 1,
          series: [advance("a", 1)],
          dropped: 0,
        },
      });
      part.actions.entries.push(actionCost("a", "sum", 5));
      const merged = mergeServingLoopStats([part]);
      part.actions.entries[0].totalMs = 99;
      part.derivedCommitsBySpace.a = 99;
      part.settleAdvances.series[0].to = 99;
      part.settle.series[0].ms = 99;
      part.lease.held = 99;
      expect(merged.derivedCommitsBySpace.a).toBe(1);
      expect(merged.settleAdvances.series[0].to).toBe(1);
      expect(merged.settle.series[0].ms).toBe(2);
      expect(merged.lease.held).toBe(0);
      expect(merged.actions.entries[0].totalMs).toBe(5);
    });
  });

  describe("closedHostServingLoopStats()", () => {
    it("keeps counters and peaks, and puts every level at zero", () => {
      const open = emptyServingLoopStats();
      open.waves = 4;
      open.activeSpaces = 2;
      open.watermarkLag = 6;
      open.memo.inflight = 3;
      open.parkedRuntimes.held = 1;
      open.parkedRuntimes.retained = 5;
      open.demand.demandedInstances = 8;
      open.demand.demandedInstancesMax = 12;
      open.events.deliveryDeferralsActive = 2;
      open.events.coalescedPerWaveMax = 7;

      const closed = closedHostServingLoopStats(open);

      expect(closed.waves).toBe(4);
      expect(closed.parkedRuntimes.retained).toBe(5);
      expect(closed.demand.demandedInstancesMax).toBe(12);
      expect(closed.events.coalescedPerWaveMax).toBe(7);
      expect(closed.activeSpaces).toBe(0);
      expect(closed.watermarkLag).toBe(0);
      expect(closed.memo.inflight).toBe(0);
      expect(closed.parkedRuntimes.held).toBe(0);
      expect(closed.demand.demandedInstances).toBe(0);
      expect(closed.events.deliveryDeferralsActive).toBe(0);
    });

    it("puts every level at zero and leaves the shape as it was", () => {
      const open = emptyServingLoopStats();
      open.activeSpaces = 1;
      open.watermarkLag = 2;
      open.demand.demandedRows = 3;
      open.demand.demandedInstances = 4;
      open.demand.demandedPairs = 5;
      open.demand.demandedWriters = 6;
      open.events.deliveryDeferralsActive = 7;
      open.events.deliveryFailuresActive = 8;
      open.events.maxAccumulatedDeliveryFailureMs = 9;
      open.memo.inflight = 10;
      open.parkedRuntimes.held = 11;
      open.workers.serving = 12;
      open.workers.spare = 13;
      open.workers.parked = 14;
      open.workers.heapUsed = 15;
      open.workers.heapStopped = 16;

      expect(closedHostServingLoopStats(open)).toEqual(
        emptyServingLoopStats(),
      );
    });

    it("keeps the action costs the host counted", () => {
      const closed = closedHostServingLoopStats(
        statsWith({
          actions: {
            entries: [actionCost("did:a", "sum", 3)],
            dropped: 0,
            droppedMs: 0,
          },
        }),
      );
      expect(closed.actions.entries).toEqual([actionCost("did:a", "sum", 3)]);
    });

    it("leaves the counters it was given as they were", () => {
      const open = statsWith({ activeSpaces: 2 });
      closedHostServingLoopStats(open);
      expect(open.activeSpaces).toBe(2);
    });
  });
});
